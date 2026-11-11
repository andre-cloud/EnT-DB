"""Tests for cached chemical and bibliographic resolvers."""

from __future__ import annotations

import httpx

from trendb.resolvers import Resolver


def test_resolver_local_and_remote_mocked() -> None:
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        calls.append(url)
        if "opsin.ch.cam.ac.uk/opsin/4-cyanobenzophenone.json" in url:
            return httpx.Response(200, json={"status": "SUCCESS", "smiles": "N#Cc1ccc(C(=O)c2ccccc2)cc1"})
        if "opsin.ch.cam.ac.uk" in url:
            return httpx.Response(404, json={"status": "FAILURE"})
        if "pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/" in url:
            return httpx.Response(
                200,
                json={"PropertyTable": {"Properties": [{"IsomericSMILES": "CC(=O)c1ccccc1"}]}},
            )
        if "pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/synonyms/" in url:
            return httpx.Response(
                200,
                json={"InformationList": {"Information": [{"Synonym": ["invalid-123", "98-86-2", "100-42-6"]}]}},
            )
        if "doi.org/api/handles/10.1021%2Fjacs.0c05069" in url:
            return httpx.Response(200, json={"responseCode": 1})
        if "api.crossref.org/works/10.1021%2Fjacs.0c05069" in url:
            return httpx.Response(
                200,
                json={
                    "message": {
                        "author": [{"family": "Elliott"}, {"family": "Kayal"}],
                        "short-container-title": ["J. Am. Chem. Soc."],
                        "published-print": {"date-parts": [[2020]]},
                        "volume": "142",
                        "page": "14947-14956",
                    }
                },
            )
        return httpx.Response(404)

    with Resolver(
        cache_path=":memory:",
        batches_dir=None,
        pubchem_interval=0.0,
        http_client=httpx.Client(transport=httpx.MockTransport(handler)),
    ) as resolver:
        # Built-in local dictionary hits without HTTP calls
        local = resolver.resolve_molecule("Thioxanthone", lookup_cas=False)
        assert local.smiles == "O=c1c2ccccc2sc2ccccc12"
        assert local.source == "local_dict"
        assert len(calls) == 0

        # Anonymous paper label never triggers external HTTP calls
        anon = resolver.resolve_molecule("compound 4a")
        assert anon.smiles is None
        assert anon.source == "unresolved"
        assert len(calls) == 0

        # OPSIN hit + PubChem CAS synonym validation (98-86-2 valid, 100-42-6 invalid check digit)
        iupac = resolver.resolve_molecule("4-cyanobenzophenone")
        assert iupac.smiles == "N#Cc1ccc(C(=O)c2ccccc2)cc1"
        assert iupac.source == "opsin"
        assert iupac.cas == "98-86-2"

        # Second lookup hits SQLite cache instead of network
        n_before = len(calls)
        iupac_cached = resolver.resolve_molecule("4-cyanobenzophenone")
        assert iupac_cached.smiles == iupac.smiles
        assert len(calls) == n_before

        # DOI resolve and Crossref formatting
        assert resolver.doi_resolves("10.1021/jacs.0c05069") is True
        cite = resolver.fetch_citation("10.1021/jacs.0c05069")
        assert cite == "Elliott, Kayal, J. Am. Chem. Soc. 2020, 142, 14947–14956"
