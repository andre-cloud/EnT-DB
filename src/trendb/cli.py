"""Command-line interfaces: trendb-extract (PDF -> batch JSON) and trendb-scrape (public DB queries)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Sequence

from .batch import build_batch, build_batch_from_review
from .client import TrEnDBClient
from .ocsr import decimer_available, predict_smiles_decimer, run_ocsr_on_pdf
from .pdf_extract import extract_pdf
from .pdf_markdown import pdf_to_markdown
from .resolvers import Resolver


def _expand_pdfs(inputs: list[str]) -> list[Path]:
    pdfs: list[Path] = []
    for item in inputs:
        p = Path(item)
        if p.is_dir():
            pdfs.extend(sorted(p.glob("*.pdf")))
        elif p.is_file():
            pdfs.append(p)
        else:
            pdfs.extend(sorted(Path().glob(item)))
    # Preserve order while deduplicating paths
    seen: set[Path] = set()
    out: list[Path] = []
    for p in pdfs:
        rp = p.resolve()
        if rp not in seen:
            seen.add(rp)
            out.append(p)
    return out


def main_extract(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="trendb-extract",
        description="Extract molecules and triplet energies from PDF papers (no LLM) and build TrEnDB batches.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_ext = sub.add_parser("extract", help="Extract entries from X PDF files or directories.")
    p_ext.add_argument("pdfs", nargs="+", help="PDF files, directories, or glob patterns.")
    p_ext.add_argument("--manifest", help="Optional JSON mapping pdf filename -> {doi, citation, role, cls}.")
    p_ext.add_argument("--doi", help="Override DOI when extracting a single PDF.")
    p_ext.add_argument("--role", default="acceptor", choices=("acceptor", "donor", "both"), help="Default role.")
    p_ext.add_argument("--cls", dest="cls_name", default=None, help="Default molecule class.")
    p_ext.add_argument("--batches-dir", default="docs/batches", help="Path to docs/batches.")
    p_ext.add_argument("--out-dir", default="extracted", help="Staging directory for preview/review/report.")
    p_ext.add_argument("--min-score", type=int, default=0, help="Minimum score to enter batch JSON directly.")
    p_ext.add_argument("--dedup-db", action="store_true", help="Also query the public TrEnDB DB for deduplication.")
    p_ext.add_argument("--offline", action="store_true", help="Disable OPSIN/PubChem/Crossref/doi.org HTTP requests.")
    p_ext.add_argument("--no-ocr", action="store_true", help="Disable Tesseract OCR fallback on scanned PDF pages.")
    p_ext.add_argument("--save-markdown", action="store_true", help="Save extracted Markdown into <out-dir>/markdown/.")
    p_ext.add_argument("--decimer", action="store_true", help="Crop figures and run DECIMER-Image_Transformer for unresolved structures.")
    p_ext.add_argument("--write-batch", action="store_true", help="Write docs/batches/batch-NNN.json and update index.json.")
    p_ext.add_argument("--batch-file", default=None, help="Explicit target batch JSON file when --write-batch is set.")

    p_md = sub.add_parser("to-md", help="Convert PDF papers into clean Markdown (with Tesseract OCR on scanned pages).")
    p_md.add_argument("pdfs", nargs="+", help="PDF files, directories, or glob patterns.")
    p_md.add_argument("--out-dir", default="extracted/markdown", help="Directory for output .md files.")
    p_md.add_argument("--lang", default="eng", help="Tesseract OCR language (default: eng).")
    p_md.add_argument("--no-ocr", action="store_true", help="Skip Tesseract OCR fallback.")

    p_ocsr = sub.add_parser("ocsr", help="Extract molecular figures from PDFs/images and predict SMILES via DECIMER-Image_Transformer.")
    p_ocsr.add_argument("inputs", nargs="+", help="Image (.png/.jpg) or PDF files.")
    p_ocsr.add_argument("--out-dir", default="extracted/figures", help="Directory for cropped figure PNGs.")

    p_bld = sub.add_parser("build-batch", help="Build a batch from a manually completed needs_review.json.")
    p_bld.add_argument("review_json", help="Path to needs_review.json.")
    p_bld.add_argument("--batches-dir", default="docs/batches", help="Path to docs/batches.")
    p_bld.add_argument("--out-dir", default="extracted", help="Staging directory for preview/review/report.")
    p_bld.add_argument("--min-score", type=int, default=0, help="Minimum score to enter batch JSON.")
    p_bld.add_argument("--dedup-db", action="store_true", help="Also query the public TrEnDB DB for deduplication.")
    p_bld.add_argument("--offline", action="store_true", help="Disable OPSIN/PubChem/doi.org HTTP requests.")
    p_bld.add_argument("--write-batch", action="store_true", help="Write docs/batches/batch-NNN.json and update index.json.")
    p_bld.add_argument("--batch-file", default=None, help="Explicit target batch JSON file when --write-batch is set.")

    args = parser.parse_args(argv)
    if args.cmd == "to-md":
        pdf_paths = _expand_pdfs(args.pdfs)
        if not pdf_paths:
            print("No PDF files matched.", file=sys.stderr)
            return 2
        out_md_dir = Path(args.out_dir)
        out_md_dir.mkdir(parents=True, exist_ok=True)
        for p in pdf_paths:
            md_path = out_md_dir / f"{p.stem}.md"
            _, _, pages = pdf_to_markdown(p, enable_ocr=not args.no_ocr, ocr_lang=args.lang, save_path=md_path)
            ocr_pages = sum(1 for pg in pages if pg.used_ocr)
            print(f"{md_path} ({len(pages)} pages, OCR used on {ocr_pages})")
        return 0

    if args.cmd == "ocsr":
        out_fig_dir = Path(args.out_dir)
        out_fig_dir.mkdir(parents=True, exist_ok=True)
        has_dec = decimer_available()
        records = []
        for raw in args.inputs:
            p = Path(raw)
            if p.suffix.lower() == ".pdf":
                figs = run_ocsr_on_pdf(p, out_fig_dir / p.stem)
                for f in figs:
                    records.append(
                        {
                            "input": p.name,
                            "page": f.page_num,
                            "image": str(f.image_path),
                            "label": f.label,
                            "smiles": f.predicted_smiles,
                            "source": f.source,
                        }
                    )
            elif p.is_file():
                smi = predict_smiles_decimer(p) if has_dec else None
                records.append({"input": str(p), "smiles": smi, "source": "decimer_image_transformer" if smi else "decimer_not_installed"})
        print(json.dumps(records, indent=2, ensure_ascii=False))
        return 0

    db_client = TrEnDBClient() if args.dedup_db else None

    try:
        extra_entries = [e.to_dict() for e in db_client.fetch_entries()] if db_client is not None else None
        with Resolver(batches_dir=args.batches_dir, extra_entries=extra_entries, offline=args.offline) as resolver:
            if args.cmd == "extract":
                pdf_paths = _expand_pdfs(args.pdfs)
                if not pdf_paths:
                    print("No PDF files matched.", file=sys.stderr)
                    return 2
                manifest: dict[str, dict[str, Any]] = {}
                if args.manifest:
                    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))

                md_dir = Path(args.out_dir) / "markdown" if args.save_markdown else None
                fig_dir = Path(args.out_dir) / "figures" if args.decimer else None
                all_candidates = []
                for p in pdf_paths:
                    meta = manifest.get(p.name, {})
                    cands = extract_pdf(
                        p,
                        resolver=resolver,
                        doi_override=args.doi or meta.get("doi"),
                        citation_override=meta.get("citation"),
                        default_role=meta.get("role", args.role),
                        default_cls=meta.get("cls", args.cls_name),
                        enable_ocr=not args.no_ocr,
                        save_markdown_dir=md_dir,
                        use_decimer=args.decimer,
                        figures_dir=fig_dir,
                    )
                    all_candidates.extend(cands)

                res = build_batch(
                    all_candidates,
                    resolver=resolver,
                    batches_dir=args.batches_dir,
                    db_client=db_client,
                    min_score=args.min_score,
                    write_batch=args.write_batch,
                    batch_file=args.batch_file,
                    out_dir=args.out_dir,
                )
            else:
                res = build_batch_from_review(
                    args.review_json,
                    resolver=resolver,
                    batches_dir=args.batches_dir,
                    db_client=db_client,
                    min_score=args.min_score,
                    write_batch=args.write_batch,
                    batch_file=args.batch_file,
                    out_dir=args.out_dir,
                )
    finally:
        if db_client is not None:
            db_client.close()

    print(
        f"Ready: {len(res.ready_rows)} | Needs review: {len(res.review_items)} | "
        f"Duplicates skipped: {len(res.skipped_duplicates)}"
    )
    if res.batch_path:
        print(f"Batch: {res.batch_path}")
    if res.review_path:
        print(f"Review: {res.review_path}")
    if res.report_path:
        print(f"Report: {res.report_path}")
    return 0


def main_scrape(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="trendb-scrape",
        description="Query and export approved entries from the public TrEnDB database.",
    )
    parser.add_argument("-q", "--text", default=None, help="Free-text query.")
    parser.add_argument("--cas", default=None, help="CAS number prefix or full CAS.")
    parser.add_argument("--origin", choices=("exp", "calc"), default=None)
    parser.add_argument("--role", choices=("acceptor", "donor", "both"), default=None)
    parser.add_argument("--cls", dest="cls_name", default=None, help="Molecule class.")
    parser.add_argument("--doi", default=None, help="Filter by source DOI.")
    parser.add_argument("--et-min", type=float, default=None, help="Minimum E_T.")
    parser.add_argument("--et-max", type=float, default=None, help="Maximum E_T.")
    parser.add_argument("--unit", choices=("kcal", "kj", "ev"), default="kcal")
    parser.add_argument("--min-score", type=int, default=None)
    parser.add_argument("--substructure", default=None, help="Substructure SMILES/SMARTS filter.")
    parser.add_argument("--smarts", action="store_true", help="Treat --substructure as SMARTS.")
    parser.add_argument("--similarity", default=None, help="Query SMILES for Tanimoto similarity.")
    parser.add_argument("--threshold", type=float, default=0.5, help="Tanimoto threshold.")
    parser.add_argument("--sort-by", choices=("added", "et_asc", "et_desc", "score_desc", "similarity"), default="added")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--batches-dir", default=None, help="Read offline from docs/batches instead of Supabase.")
    parser.add_argument("--user", default=None, help="Optional site_access username.")
    parser.add_argument("--password", default=None, help="Optional site_access password.")
    parser.add_argument("--format", choices=("json", "csv", "sdf"), default="json")
    parser.add_argument("-o", "--output", default=None, help="Output file path (stdout for json if omitted).")

    args = parser.parse_args(argv)
    client = (
        TrEnDBClient.from_batches(args.batches_dir)
        if args.batches_dir
        else TrEnDBClient(site_user=args.user, site_pass=args.password)
    )
    try:
        res = client.search(
            q=args.text,
            cas=args.cas,
            origin=args.origin,
            role=args.role,
            cls=args.cls_name,
            doi=args.doi,
            et_min=args.et_min,
            et_max=args.et_max,
            et_unit=args.unit,
            min_score=args.min_score,
            substructure=args.substructure,
            smarts=args.smarts,
            similarity_smiles=args.similarity,
            similarity_threshold=args.threshold,
            sort_by=args.sort_by,
            limit=args.limit,
        )
    finally:
        client.close()

    if args.format == "csv":
        if not args.output:
            raise SystemExit("--output is required for --format csv")
        res.to_csv(args.output)
    elif args.format == "sdf":
        if not args.output:
            raise SystemExit("--output is required for --format sdf")
        res.to_sdf(args.output)
    else:
        if args.output:
            res.to_json(args.output)
        else:
            print(json.dumps(res.to_dicts(), indent=2, ensure_ascii=False))
    return 0


def main_stats(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="trendb-stats",
        description="Compute descriptive statistics, exp-vs-calc metrics, and molecular descriptors on TrEnDB.",
    )
    parser.add_argument("--origin", choices=("exp", "calc"), default=None)
    parser.add_argument("--role", choices=("acceptor", "donor", "both"), default=None)
    parser.add_argument("--cls", dest="cls_name", default=None)
    parser.add_argument("--min-score", type=int, default=None)
    parser.add_argument("--batches-dir", default=None, help="Analyze local docs/batches offline instead of Supabase.")
    parser.add_argument("--user", default=None, help="Optional site_access username.")
    parser.add_argument("--password", default=None, help="Optional site_access password.")
    parser.add_argument("--exp-vs-calc", action="store_true", help="Print experimental vs computed benchmark table.")
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    parser.add_argument("-o", "--output", default=None, help="Write report to file.")
    parser.add_argument("--descriptors-csv", default=None, help="Also export RDKit descriptors + E_T to CSV.")

    args = parser.parse_args(argv)
    client = (
        TrEnDBClient.from_batches(args.batches_dir)
        if args.batches_dir
        else TrEnDBClient(site_user=args.user, site_pass=args.password)
    )
    try:
        res = client.search(
            origin=args.origin,
            role=args.role,
            cls=args.cls_name,
            min_score=args.min_score,
        )
    finally:
        client.close()

    if args.descriptors_csv:
        import csv

        desc_rows = res.descriptors()
        out_csv = Path(args.descriptors_csv)
        out_csv.parent.mkdir(parents=True, exist_ok=True)
        if desc_rows:
            with out_csv.open("w", newline="", encoding="utf-8") as fh:
                writer = csv.DictWriter(fh, fieldnames=list(desc_rows[0].keys()))
                writer.writeheader()
                writer.writerows(desc_rows)
        else:
            out_csv.write_text("", encoding="utf-8")

    if args.exp_vs_calc:
        ec = res.exp_vs_calc()
        if args.format == "json":
            text = json.dumps(
                {
                    "n_molecules": ec.n_molecules,
                    "mae": ec.mae,
                    "rmse": ec.rmse,
                    "bias": ec.bias,
                    "max_abs_error": ec.max_abs_error,
                    "pearson_r": ec.pearson_r,
                    "r2": ec.r2,
                    "pairs": ec.to_dicts(),
                },
                indent=2,
                ensure_ascii=False,
            )
        else:
            text = ec.to_markdown()
    else:
        st = res.stats()
        text = json.dumps(st.to_dict(), indent=2, ensure_ascii=False) if args.format == "json" else st.to_markdown()

    if args.output:
        out_p = Path(args.output)
        out_p.parent.mkdir(parents=True, exist_ok=True)
        out_p.write_text(text, encoding="utf-8")
    else:
        print(text)
    return 0
