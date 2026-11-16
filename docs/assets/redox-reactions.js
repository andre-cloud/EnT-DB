/* Reaction types for the reactivity advisor of the Redox section: for each transformation, the
   electron donor and acceptor with their potentials (V vs SCE), which one is the substrate to
   activate ("key"), the quenching mechanism reported by the authors and the catalysts they used.
   "soft": the potential is an estimate (radical intermediate, terminal oxidant), so a step that
   depends on it only downgrades a verdict. Sources are cited by DOI.
   From RedoxDB (alebusso12, data/reactions.json), used with permission. Curated here: edit by pull request. */
window.EntRedoxReactions = [
 {
  "id": "decarbox-arylation-ni",
  "name": "Decarboxylative C(sp3)–C(sp2) arylation (photoredox/Ni dual catalysis)",
  "family": "Cross-coupling",
  "summary": "α-Amino/α-oxy carboxylic acids couple with aryl halides; the carboxylate is oxidised by PC*, CO2 is lost and the alkyl radical enters the Ni cycle.",
  "donor": {
   "name": "Boc-Pro-OCs (carboxylate)",
   "class": "carboxylate",
   "E_ox": 0.95
  },
  "acceptor": {
   "name": "Ni(I)/Ni(0) (dtbbpy)",
   "class": "Ni co-catalyst",
   "E_red": -1.17
  },
  "key": "donor",
  "reported_quenching": "reductive",
  "typical_pc": [
   "Ir[dF(CF3)ppy]2(dtbbpy)PF6",
   "4CzIPN"
  ],
  "doi": "10.1126/science.1255525",
  "citation": "Zuo, Ahneman, Chu, Terrett, Doyle, MacMillan, Science 2014, 345, 437",
  "notes": "Ni(I)/Ni(0) value as used by the authors to rationalise turnover."
 },
 {
  "id": "decarbox-giese",
  "name": "Decarboxylative conjugate addition (Giese) of carboxylic acids",
  "family": "Radical addition",
  "summary": "Carboxylate oxidation by PC*, decarboxylation, radical addition to a Michael acceptor; the α-carbonyl radical is reduced by PC•− and protonated.",
  "donor": {
   "name": "N-Boc α-amino carboxylate",
   "class": "carboxylate",
   "E_ox": 0.95
  },
  "acceptor": {
   "name": "α-carbonyl radical adduct",
   "class": "radical intermediate",
   "E_red": -0.6,
   "soft": true
  },
  "key": "donor",
  "reported_quenching": "reductive",
  "typical_pc": [
   "Ir[dF(CF3)ppy]2(dtbbpy)PF6"
  ],
  "doi": "10.1021/ja505964r",
  "citation": "Chu, Ohta, Zuo, MacMillan, J. Am. Chem. Soc. 2014, 136, 10886",
  "notes": "Radical-adduct potential is an estimate; treat the turnover step as indicative."
 },
 {
  "id": "bf3k-arylation-ni",
  "name": "Benzylic/alkyl trifluoroborate cross-coupling (photoredox/Ni)",
  "family": "Cross-coupling",
  "summary": "Single-electron oxidation of R–BF3K releases the alkyl radical that is captured by Ni.",
  "donor": {
   "name": "BnBF3K",
   "class": "organotrifluoroborate",
   "E_ox": 1.1
  },
  "acceptor": {
   "name": "Ni(I)/Ni(0)",
   "class": "Ni co-catalyst",
   "E_red": -1.17
  },
  "key": "donor",
  "reported_quenching": "reductive",
  "typical_pc": [
   "Ir[dF(CF3)ppy]2(bpy)PF6"
  ],
  "doi": "10.1126/science.1253647",
  "citation": "Tellis, Primer, Molander, Science 2014, 345, 433",
  "notes": "Secondary alkyl BF3K salts are harder to oxidise (≈ +1.5 V)."
 },
 {
  "id": "silicate-arylation-ni",
  "name": "Alkyl bis(catecholato)silicate cross-coupling (photoredox/Ni)",
  "family": "Cross-coupling",
  "summary": "Silicates are oxidised at low potential, so weaker (and organic) photocatalysts suffice.",
  "donor": {
   "name": "cyclohexyl bis(catecholato)silicate",
   "class": "silicate",
   "E_ox": 0.69
  },
  "acceptor": {
   "name": "Ni(I)/Ni(0)",
   "class": "Ni co-catalyst",
   "E_red": -1.17
  },
  "key": "donor",
  "reported_quenching": "reductive",
  "typical_pc": [
   "Ir[dF(CF3)ppy]2(bpy)PF6",
   "4CzIPN"
  ],
  "doi": "10.1021/jacs.5b10963",
  "citation": "Jouffroy, Primer, Molander, J. Am. Chem. Soc. 2016, 138, 475"
 },
 {
  "id": "anti-markovnikov-hydroetherification",
  "name": "Anti-Markovnikov hydrofunctionalisation of alkenes",
  "family": "Alkene functionalisation",
  "summary": "Alkene radical cation from PC*, anti-Markovnikov attack of a nucleophile (alcohol, amine, acid), then H-atom transfer from a thiol; the thiyl radical reoxidises PC•−.",
  "donor": {
   "name": "trisubstituted / styrenyl alkene",
   "class": "alkene",
   "E_ox": 1.7
  },
  "acceptor": {
   "name": "thiyl radical (PhS•/PhS−)",
   "class": "HAT co-catalyst",
   "E_red": 0.16
  },
  "key": "donor",
  "reported_quenching": "reductive",
  "typical_pc": [
   "9-Mesityl-10-methylacridinium",
   "tBu-Mes-Acr-Ph+"
  ],
  "doi": "10.1021/ja309635w",
  "citation": "Hamilton, Nicewicz, J. Am. Chem. Soc. 2012, 134, 18577",
  "notes": "Electron-rich alkenes E_ox ≈ +1.2 to +2.0 V; only highly oxidising PCs (acridinium, pyrylium) reach the less activated ones."
 },
 {
  "id": "hydrotrifluoromethylation",
  "name": "Hydrotrifluoromethylation of alkenes with CF3SO2Na (Langlois)",
  "family": "Fluoroalkylation",
  "summary": "PC* oxidises sulfinate → CF3• (after SO2 loss), addition to the alkene, H-atom transfer from a thiol co-catalyst.",
  "donor": {
   "name": "CF3SO2Na",
   "class": "sulfinate",
   "E_ox": 1.05
  },
  "acceptor": {
   "name": "thiyl radical (HAT co-catalyst)",
   "class": "HAT co-catalyst",
   "E_red": 0.16,
   "soft": true
  },
  "key": "donor",
  "reported_quenching": "reductive",
  "typical_pc": [
   "9-Mesityl-10-methylacridinium"
  ],
  "doi": "10.1039/c3sc51209f",
  "citation": "Wilger, Hamilton, Nicewicz et al., Chem. Sci. 2013"
 },
 {
  "id": "arene-amination",
  "name": "Arene C–H amination with azoles",
  "family": "C–H functionalisation",
  "summary": "Arene radical cation from PC*, attack by an azole nucleophile, rearomatisation; O2/TEMPO is the terminal oxidant.",
  "donor": {
   "name": "anisole",
   "class": "arene",
   "E_ox": 1.76
  },
  "acceptor": {
   "name": "O2 (terminal oxidant)",
   "class": "oxidant",
   "E_red": -0.87,
   "soft": true
  },
  "key": "donor",
  "reported_quenching": "reductive",
  "typical_pc": [
   "tBu-Mes-Acr-Ph+"
  ],
  "doi": "10.1126/science.aac9895",
  "citation": "Romero, Margrey, Tay, Nicewicz, Science 2015, 349, 1326",
  "notes": "Turnover by O2 is formally uphill for Acr• and is driven by fast follow-up steps; shown for information only."
 },
 {
  "id": "arene-cyanation",
  "name": "Arene C–H cyanation",
  "family": "C–H functionalisation",
  "summary": "As arene amination, with TMSCN as nucleophile under air.",
  "donor": {
   "name": "anisole / electron-rich arene",
   "class": "arene",
   "E_ox": 1.76
  },
  "acceptor": {
   "name": "O2 (terminal oxidant)",
   "class": "oxidant",
   "E_red": -0.87,
   "soft": true
  },
  "key": "donor",
  "reported_quenching": "reductive",
  "typical_pc": [
   "tBu-Mes-Acr-Ph+"
  ],
  "doi": "10.1021/jacs.6b12708",
  "citation": "McManus, Nicewicz, J. Am. Chem. Soc. 2017, 139, 2880"
 },
 {
  "id": "radical-cation-2+2",
  "name": "Radical-cation [2+2] cycloaddition of electron-rich styrenes",
  "family": "Cycloaddition",
  "summary": "PC* oxidises the electron-rich alkene; the radical cation adds to a second alkene; methyl viologen/O2 regenerates the catalyst.",
  "donor": {
   "name": "trans-anethole",
   "class": "alkene",
   "E_ox": 1.1
  },
  "acceptor": {
   "name": "methyl viologen MV2+",
   "class": "electron relay",
   "E_red": -0.69
  },
  "key": "donor",
  "reported_quenching": "reductive",
  "typical_pc": [
   "Ru(bpz)3(PF6)2"
  ],
  "doi": "10.1021/ja103934y",
  "citation": "Ischay, Lu, Yoon, J. Am. Chem. Soc. 2010, 132, 8572"
 },
 {
  "id": "enone-2+2",
  "name": "Radical-anion [2+2] cycloaddition of aryl enones",
  "family": "Cycloaddition",
  "summary": "PC•− (from reductive quenching by an amine) reduces a Lewis-acid-activated aryl enone; the radical anion cyclises.",
  "donor": {
   "name": "iPr2NEt",
   "class": "amine",
   "E_ox": 0.65
  },
  "acceptor": {
   "name": "aryl enone (LiBF4 activated)",
   "class": "enone",
   "E_red": -1.4
  },
  "key": "acceptor",
  "reported_quenching": "reductive",
  "typical_pc": [
   "Ru(bpy)3Cl2"
  ],
  "doi": "10.1021/ja805387f",
  "citation": "Ischay, Anzovino, Du, Yoon, J. Am. Chem. Soc. 2008, 130, 12886",
  "notes": "Free aryl enones are reduced at ≈ −1.5 to −1.8 V; Li+ coordination makes them easier to reduce."
 },
 {
  "id": "reductive-dehalogenation-activated",
  "name": "Reductive dehalogenation of activated alkyl halides",
  "family": "Reduction",
  "summary": "Amine reductive quenching of PC*, then PC•− reduces an α-halo carbonyl; H-atom from the amine radical cation or Hantzsch ester.",
  "donor": {
   "name": "iPr2NEt",
   "class": "amine",
   "E_ox": 0.65
  },
  "acceptor": {
   "name": "diethyl bromomalonate",
   "class": "alkyl halide",
   "E_red": -0.49
  },
  "key": "acceptor",
  "reported_quenching": "reductive",
  "typical_pc": [
   "Ru(bpy)3Cl2"
  ],
  "doi": "10.1021/ja9033582",
  "citation": "Narayanam, Tucker, Stephenson, J. Am. Chem. Soc. 2009, 131, 8756"
 },
 {
  "id": "unactivated-iodide-reduction",
  "name": "Reduction of unactivated alkyl, vinyl and aryl iodides",
  "family": "Reduction",
  "summary": "Strongly reducing PC* (oxidative quenching) cleaves C–I bonds; the radical is trapped (H-atom, cyclisation).",
  "donor": {
   "name": "nBu3N (with HCO2H)",
   "class": "amine",
   "E_ox": 0.8,
   "soft": true
  },
  "acceptor": {
   "name": "unactivated alkyl/aryl iodide",
   "class": "alkyl/aryl halide",
   "E_red": -1.9
  },
  "key": "acceptor",
  "reported_quenching": "oxidative",
  "typical_pc": [
   "fac-Ir(ppy)3"
  ],
  "doi": "10.1038/nchem.1452",
  "citation": "Nguyen, D'Amato, Narayanam, Stephenson, Nat. Chem. 2012, 4, 854",
  "notes": "Dissociative electron transfer to C–I bonds proceeds even when formally ~0.2 eV uphill."
 },
 {
  "id": "aryl-halide-reduction-strong",
  "name": "Reduction of aryl bromides/chlorides (strongly reducing PCs)",
  "family": "Reduction",
  "summary": "Aryl radicals from aryl bromides/chlorides by very strong excited-state reductants (phenothiazines, dihydrophenazines, ConPET).",
  "donor": {
   "name": "nBu3N / Et3N",
   "class": "amine",
   "E_ox": 0.8,
   "soft": true
  },
  "acceptor": {
   "name": "aryl bromide (e.g. 4-bromoanisole)",
   "class": "aryl halide",
   "E_red": -2.2
  },
  "key": "acceptor",
  "reported_quenching": "oxidative",
  "typical_pc": [
   "10-Phenylphenothiazine (PTH)"
  ],
  "doi": "10.1039/C5CC04677G",
  "citation": "Discekici, Treat, Poelma, ... Hawker, Read de Alaniz, Chem. Commun. 2015, 51, 11705",
  "notes": "Aryl chlorides need ≈ −2.5 to −2.9 V: see consecutive photoinduced electron transfer (ConPET), Ghosh, Ghosh, Shaikh, König, Science 2014, 10.1126/science.1258232."
 },
 {
  "id": "atra",
  "name": "Atom-transfer radical addition (ATRA) of haloalkanes to alkenes",
  "family": "Radical addition",
  "summary": "PC* (oxidative quenching) reduces the C–X bond; radical adds to the alkene; PC•+ oxidises the adduct radical, which captures halide (or chain transfer).",
  "donor": {
   "name": "adduct radical",
   "class": "radical intermediate",
   "E_ox": 0.3,
   "soft": true
  },
  "acceptor": {
   "name": "BrCCl3 / diethyl bromomalonate / perfluoroalkyl iodide",
   "class": "alkyl halide",
   "E_red": -0.49
  },
  "key": "acceptor",
  "reported_quenching": "oxidative",
  "typical_pc": [
   "Ir[dF(CF3)ppy]2(dtbbpy)PF6",
   "Ru(bpy)3Cl2"
  ],
  "doi": "10.1021/ja108560e",
  "citation": "Nguyen, Stephenson, J. Am. Chem. Soc. 2011, 133, 4160",
  "notes": "Perfluoroalkyl iodides (≈ −1.2 V) need a stronger reductant than bromomalonates."
 },
 {
  "id": "arene-trifluoromethylation",
  "name": "(Hetero)arene C–H trifluoromethylation with CF3SO2Cl",
  "family": "Fluoroalkylation",
  "summary": "PC* reduces CF3SO2Cl (→ CF3• + SO2 + Cl−); CF3• adds to the arene; PC•+ oxidises the cyclohexadienyl radical, deprotonation rearomatises.",
  "donor": {
   "name": "cyclohexadienyl radical adduct",
   "class": "radical intermediate"
  },
  "acceptor": {
   "name": "CF3SO2Cl",
   "class": "CF3 source",
   "E_red": -0.18
  },
  "key": "acceptor",
  "reported_quenching": "oxidative",
  "typical_pc": [
   "Ru(phen)3Cl2",
   "Ir(Fppy)3"
  ],
  "doi": "10.1038/nature10647",
  "citation": "Nagib, MacMillan, Nature 2011, 480, 224"
 },
 {
  "id": "meerwein-arylation",
  "name": "C–H arylation of heteroarenes with aryl diazonium salts",
  "family": "C–H functionalisation",
  "summary": "PC* reduces ArN2+ to Ar• (N2 loss); Ar• adds to the heteroarene; PC•+ oxidises the adduct radical.",
  "donor": {
   "name": "radical adduct",
   "class": "radical intermediate"
  },
  "acceptor": {
   "name": "aryl diazonium tetrafluoroborate",
   "class": "diazonium",
   "E_red": -0.1
  },
  "key": "acceptor",
  "reported_quenching": "oxidative",
  "typical_pc": [
   "Eosin Y"
  ],
  "doi": "10.1021/ja212099r",
  "citation": "Hari, Schroll, König, J. Am. Chem. Soc. 2012, 134, 2958",
  "notes": "Diazonium salts are among the easiest radical precursors to reduce: almost any PC works."
 },
 {
  "id": "alpha-amino-arylation",
  "name": "α-Amino C–H arylation with cyanoarenes",
  "family": "C–H functionalisation",
  "summary": "PC* reduces the cyanoarene to its persistent radical anion; PC•+ oxidises the amine, deprotonation gives the α-amino radical, radical–radical coupling and cyanide loss.",
  "donor": {
   "name": "N-phenylpyrrolidine",
   "class": "amine",
   "E_ox": 0.7
  },
  "acceptor": {
   "name": "1,4-dicyanobenzene",
   "class": "cyanoarene",
   "E_red": -1.61
  },
  "key": "donor",
  "reported_quenching": "oxidative",
  "typical_pc": [
   "fac-Ir(ppy)3"
  ],
  "doi": "10.1126/science.1213920",
  "citation": "McNally, Prier, MacMillan, Science 2011, 334, 1114"
 },
 {
  "id": "aza-henry",
  "name": "Oxidative aza-Henry / Mannich of N-aryl tetrahydroisoquinolines",
  "family": "C–H functionalisation",
  "summary": "PC* oxidises the tertiary amine; the α-amino radical is oxidised to the iminium, which is trapped by nitromethane or other nucleophiles. O2 (or BrCCl3) closes the cycle.",
  "donor": {
   "name": "N-phenyl-1,2,3,4-tetrahydroisoquinoline",
   "class": "amine",
   "E_ox": 0.8
  },
  "acceptor": {
   "name": "O2 (terminal oxidant)",
   "class": "oxidant",
   "E_red": -0.87,
   "soft": true
  },
  "key": "donor",
  "reported_quenching": "reductive",
  "typical_pc": [
   "Ir(ppy)2(dtbbpy)PF6",
   "Ru(bpy)3Cl2",
   "Eosin Y",
   "Rose Bengal"
  ],
  "doi": "10.1021/ja909145y",
  "citation": "Condie, González-Gómez, Stephenson, J. Am. Chem. Soc. 2010, 132, 1464",
  "notes": "Amine potential approximate."
 },
 {
  "id": "aldehyde-alpha-alkylation",
  "name": "Enantioselective α-alkylation of aldehydes (photoredox/organocatalysis)",
  "family": "Organocatalysis",
  "summary": "PC•− reduces an α-bromocarbonyl; the electrophilic radical adds to a chiral enamine; the α-amino radical is oxidised by PC* (or chain).",
  "donor": {
   "name": "α-amino radical / enamine",
   "class": "enamine",
   "E_ox": 0.8,
   "soft": true
  },
  "acceptor": {
   "name": "diethyl bromomalonate",
   "class": "alkyl halide",
   "E_red": -0.49
  },
  "key": "acceptor",
  "reported_quenching": "reductive",
  "typical_pc": [
   "Ru(bpy)3Cl2"
  ],
  "doi": "10.1126/science.1161976",
  "citation": "Nicewicz, MacMillan, Science 2008, 322, 77"
 },
 {
  "id": "hat-alcohol-alkylation",
  "name": "Site-selective α-C–H alkylation of alcohols (photoredox + quinuclidine HAT)",
  "family": "C–H functionalisation",
  "summary": "PC* oxidises quinuclidine; its radical cation abstracts the α-hydroxy C–H; the radical adds to an acrylate; PC•− reduces the adduct radical.",
  "donor": {
   "name": "quinuclidine (HAT catalyst)",
   "class": "amine",
   "E_ox": 1.1
  },
  "acceptor": {
   "name": "α-carbonyl radical adduct",
   "class": "radical intermediate",
   "E_red": -0.6,
   "soft": true
  },
  "key": "donor",
  "reported_quenching": "reductive",
  "typical_pc": [
   "Ir[dF(CF3)ppy]2(dtbbpy)PF6"
  ],
  "doi": "10.1126/science.aac8555",
  "citation": "Jeffrey, Terrett, MacMillan, Science 2015, 349, 1532"
 },
 {
  "id": "nhpi-oxalate-alkylation",
  "name": "Radical generation from N-acyloxyphthalimides (redox-active esters/oxalates)",
  "family": "Radical addition",
  "summary": "PC•− (after reductive quenching by Hantzsch ester) reduces the redox-active ester: N–O cleavage, CO2 loss, alkyl radical.",
  "donor": {
   "name": "Hantzsch ester",
   "class": "sacrificial donor",
   "E_ox": 0.89
  },
  "acceptor": {
   "name": "N-(acyloxy)phthalimide",
   "class": "redox-active ester",
   "E_red": -1.28
  },
  "key": "acceptor",
  "reported_quenching": "reductive",
  "typical_pc": [
   "Ru(bpy)3(BF4)2"
  ],
  "doi": "10.1021/ja408971t",
  "citation": "Lackner, Quasdorf, Overman, J. Am. Chem. Soc. 2013, 135, 15342",
  "notes": "NHPI esters span ≈ −1.2 to −1.4 V; tetrachloro-NHPI (TCNHPI) esters are ≈ 0.3 V easier to reduce."
 },
 {
  "id": "katritzky-deamination",
  "name": "Deaminative alkylation via Katritzky pyridinium salts",
  "family": "Radical addition",
  "summary": "Reduction of the N-alkyl-2,4,6-triphenylpyridinium releases the alkyl radical from a primary amine.",
  "donor": {
   "name": "Hantzsch ester / amine",
   "class": "sacrificial donor",
   "E_ox": 0.89,
   "soft": true
  },
  "acceptor": {
   "name": "N-alkyl-2,4,6-triphenylpyridinium",
   "class": "pyridinium (Katritzky)",
   "E_red": -0.93
  },
  "key": "acceptor",
  "reported_quenching": "oxidative",
  "typical_pc": [
   "Eosin Y",
   "Ir(ppy)3"
  ],
  "citation": "Class-level guide; see Glorius (Angew. Chem. 2017) and Watson (2017–2019) for primary reports",
  "notes": "Primary reference to be added by a curator."
 },
 {
  "id": "ketyl-olefin-pcet",
  "name": "Ketyl–olefin cyclisation by proton-coupled electron transfer",
  "family": "Reduction (PCET)",
  "summary": "A Brønsted acid H-bonds to the ketone so that PC•− can reduce it far below its normal E_red (concerted PCET).",
  "donor": {
   "name": "Hantzsch ester",
   "class": "sacrificial donor",
   "E_ox": 0.89
  },
  "acceptor": {
   "name": "aryl ketone (without acid)",
   "class": "carbonyl",
   "E_red": -2.1
  },
  "key": "acceptor",
  "reported_quenching": "reductive",
  "pcet": true,
  "typical_pc": [
   "Ru(bpy)3(BArF)2"
  ],
  "doi": "10.1021/ja404342j",
  "citation": "Tarantino, Liu, Knowles, J. Am. Chem. Soc. 2013, 135, 10022",
  "notes": "Pure electron-transfer analysis predicts failure; PCET lowers the effective barrier by >0.8 V."
 }
];
