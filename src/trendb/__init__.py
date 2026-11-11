"""Python SDK for public TrEnDB querying/scraping, statistics, and no-LLM PDF batch extraction."""

from .batch import BatchBuildResult, build_batch, build_batch_from_review, validate_batch_rows
from .clean_fields import (
    audit_conciseness,
    clean_conditions,
    clean_direct_exc,
    clean_et_type,
    clean_method,
    clean_uv,
    normalize_row_fields,
    parse_direct_exc,
    parse_uv_fields,
)
from .client import TrEnDBClient, TrEnDBError
from .config import TrEnDBConfig, load_config
from .models import Entry, MoleculeGroup, ScoreItem, UseReference
from .ocsr import ExtractedFigure, extract_figures_from_pdf, predict_smiles_decimer, run_ocsr_on_pdf
from .pdf_extract import ExtractedCandidate, extract_pdf
from .pdf_markdown import MarkdownPage, pdf_to_markdown
from .query import QueryBuilder, SearchResult, filter_entries, group_by_molecule
from .resolvers import ResolvedMolecule, Resolver
from .stats import (
    DatabaseStats,
    ExpCalcPair,
    ExpCalcSummary,
    MoleculeSpread,
    NumericStats,
    analyze_entries,
    compare_exp_calc,
    compute_descriptors,
    et_histogram,
    molecule_spread,
    summarize_numbers,
)

__all__ = [
    "BatchBuildResult",
    "DatabaseStats",
    "Entry",
    "ExpCalcPair",
    "ExpCalcSummary",
    "ExtractedCandidate",
    "ExtractedFigure",
    "MarkdownPage",
    "MoleculeGroup",
    "MoleculeSpread",
    "NumericStats",
    "QueryBuilder",
    "ResolvedMolecule",
    "Resolver",
    "ScoreItem",
    "SearchResult",
    "TrEnDBClient",
    "TrEnDBConfig",
    "TrEnDBError",
    "UseReference",
    "analyze_entries",
    "audit_conciseness",
    "build_batch",
    "build_batch_from_review",
    "clean_conditions",
    "clean_direct_exc",
    "clean_et_type",
    "clean_method",
    "clean_uv",
    "compare_exp_calc",
    "compute_descriptors",
    "et_histogram",
    "extract_figures_from_pdf",
    "extract_pdf",
    "filter_entries",
    "group_by_molecule",
    "load_config",
    "molecule_spread",
    "normalize_row_fields",
    "parse_direct_exc",
    "parse_uv_fields",
    "pdf_to_markdown",
    "predict_smiles_decimer",
    "run_ocsr_on_pdf",
    "summarize_numbers",
    "validate_batch_rows",
]
