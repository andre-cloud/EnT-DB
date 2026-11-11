-- Idempotent cleanup of verbose prose in uv_lmax/uv_eps/uv_cond, direct_exc, et_type, method, conditions
-- Run supabase/schema.sql FIRST (which migrates legacy uv/direct_exc columns), then run this file.

-- Structured UV-vis & direct_exc for already-imported batch-001 rows (keyed by import_key)
update public.entries set uv_lmax = 321, uv_eps = 61,  uv_cond = 'THF, 10⁻⁴ M; ε at 427 nm', direct_exc = '{"irradiation": 427}'::jsonb where import_key = 'anie.202520339:exp:C1';
update public.entries set uv_lmax = 309, uv_eps = 113, uv_cond = 'THF, 10⁻⁴ M; ε at 427 nm', direct_exc = '{"irradiation": 427}'::jsonb where import_key = 'anie.202520339:exp:C2';
update public.entries set uv_lmax = 325, uv_eps = 55,  uv_cond = 'THF, 10⁻⁴ M; ε at 427 nm', direct_exc = '{"irradiation": 427}'::jsonb where import_key = 'anie.202520339:exp:C3';
update public.entries set uv_lmax = 300, uv_eps = 3,   uv_cond = 'THF, 10⁻⁴ M; ε at 427 nm', direct_exc = '{"irradiation": 427}'::jsonb where import_key = 'anie.202520339:exp:C4';
update public.entries set uv_lmax = 326, uv_eps = 16,  uv_cond = 'THF, 10⁻⁴ M; ε at 427 nm', direct_exc = '{"irradiation": 427}'::jsonb where import_key = 'anie.202520339:exp:C5';
update public.entries set uv_lmax = 321, uv_eps = 61,  uv_cond = 'THF, 10⁻⁴ M; ε at 427 nm' where import_key = 'anie.202520339:calc:C1';
update public.entries set uv_lmax = 309, uv_eps = 113, uv_cond = 'THF, 10⁻⁴ M; ε at 427 nm' where import_key = 'anie.202520339:calc:C2';
update public.entries set uv_lmax = 325, uv_eps = 55,  uv_cond = 'THF, 10⁻⁴ M; ε at 427 nm' where import_key = 'anie.202520339:calc:C3';
update public.entries set uv_lmax = 300, uv_eps = 3,   uv_cond = 'THF, 10⁻⁴ M; ε at 427 nm' where import_key = 'anie.202520339:calc:C4';
update public.entries set uv_lmax = 326, uv_eps = 16,  uv_cond = 'THF, 10⁻⁴ M; ε at 427 nm' where import_key = 'anie.202520339:calc:C5';
update public.entries set uv_lmax = 328, uv_eps = 20000, uv_cond = 'MeCN; ε(415 nm) 260 M⁻¹ cm⁻¹', direct_exc = '{"LED": 415}'::jsonb where import_key = 'jacs.1c11667:exp:bcf';
update public.entries set uv_lmax = 343, uv_eps = 12500, uv_cond = 'MeCN; ε(415 nm) 520 M⁻¹ cm⁻¹' where import_key = 'jacs.1c11667:exp:cn';
update public.entries set uv_lmax = 380, uv_eps = 6166,  uv_cond = 'MeCN (also 260 nm log ε 4.74, 310 nm 4.53)' where import_key = 'cm051312:exp:1';
update public.entries set uv_cond = 'MeCN, 10⁻⁴ M' where import_key like 'jacs.0c05069:%' and uv_cond like '%1 × 10%';

-- et_type
update public.entries set et_type = 'Computed, adiabatic (ΔG)' where et_type = 'Computed, adiabatic (ΔG between optimised T1 and S0)';
update public.entries set et_type = 'Computed (type unstated)' where et_type = 'Computed; the caption does not say whether vertical or adiabatic';
update public.entries set et_type = 'Computed (type unstated)' where et_type = 'Computed; the paper does not say whether vertical or adiabatic';
update public.entries set et_type = '77 K emission max (est. 0-0)' where et_type = 'Estimated from the 77 K emission maximum, using the offset between first vibronic band and maximum found for C1';
update public.entries set et_type = '77 K emission (band unstated)' where et_type = 'From the 77 K emission; the band used is not stated in the main text';
update public.entries set et_type = '77 K emission, highest-energy peak' where et_type = 'From the highest-energy emission peak at 77 K';
update public.entries set et_type = '77 K emission, 0-0 band' where et_type = 'From the highest-energy vibronic band of the 77 K emission';
update public.entries set et_type = 'Phosphorescence (~450 nm max)' where et_type = 'From the phosphorescence spectrum (maximum near 450 nm)';
update public.entries set et_type = 'Phosphorescence (band unstated)' where et_type = 'From the phosphorescence spectrum; band used not stated in the main text';
update public.entries set et_type = 'Phosphorescence (0-0/onset unstated)' where et_type = 'From the phosphorescence spectrum; the paper does not say whether the 0-0 band or the onset was used';
update public.entries set et_type = 'Not stated' where et_type = 'Not stated per compound';
update public.entries set et_type = 'Emission max (rt, vertical)' where et_type = 'Room-temperature emission maximum (not the 0-0 band)';
update public.entries set et_type = 'Spectroscopic, 0-0 band' where et_type = 'Spectroscopic: 0,0 band or longest-wavelength S0→T1 absorption';

-- method
update public.entries set method = 'DFT, M06-2X/6-31G(d)' where method = 'DFT, M06-2X/6-31G(d), as stated in the caption of Figure 3; the authors'' data file gives MIDI! as the optimisation basis';
update public.entries set method = 'DFT, ωB97X-D/6-311G(d,p)' where method = 'DFT, ωB97X-D/6-311G(d,p). The functional reads “B97X-D” in the text extracted from the PDF; ωB97X-D is assumed.';
update public.entries set method = 'DFT, ωB97X-D4/def2-TZVPP // def2-TZVP' where method = 'DFT, ωB97X-D4/def2-TZVP (optimisation, frequencies) // def2-TZVPP single point';
update public.entries set method = 'Phosphorescence (matrix)' where method = 'Emission (phosphorescence) spectroscopy in a frozen matrix';
update public.entries set method = 'Phosphorescence (glass)' where method = 'Emission (phosphorescence) spectroscopy in a glassy matrix';
update public.entries set method = 'S0→T1 absorption (MeI perturbed)' where method = 'Heavy-atom perturbed S0→T1 absorption (methyl iodide as perturber)';
update public.entries set method = 'Phosphorescence' where method = 'Luminescence (phosphorescence) spectroscopy';
update public.entries set method = 'S0→T1 absorption (magnetic)' where method = 'Magnetically perturbed S0→T1 absorption spectroscopy';
update public.entries set method = 'Phosphorescence' where method = 'Phosphorescence emission spectroscopy';
update public.entries set method = 'Phosphorescence' where method = 'Phosphorescence spectra';
update public.entries set method = 'Phosphorescence' where method = 'Phosphorescence spectra, as stated for the whole figure';
update public.entries set method = 'PAC (direct excitation)' where method = 'Time-resolved photoacoustic calorimetry, direct excitation';
update public.entries set method = 'PAC (benzophenone sensitized)' where method = 'Time-resolved photoacoustic calorimetry, sensitised by benzophenone';
update public.entries set method = 'PAC (xanthone sensitized)' where method = 'Time-resolved photoacoustic calorimetry, sensitised by xanthone';
update public.entries set method = 'EnT kinetics (LFP, thermal activation fit)' where method = 'Triplet energy-transfer rate constants from thioxanthone- and Ir-based sensitizers (laser flash photolysis), fitted with a thermal activation model for endothermic transfer';

-- conditions
update public.entries set conditions = '2-MeTHF glass, 77 K' where conditions = '2-Methyltetrahydrofuran glass, 77 K';
update public.entries set conditions = '2-MeTHF, 77 K' where conditions = '2-Methyltetrahydrofuran, 77 K';
update public.entries set conditions = '77 K (solvent in SI)' where conditions = '77 K; the solvent or glass is not given in the main text (see the SI)';
update public.entries set conditions = 'MeCN (25 μM), rt' where conditions = 'Acetonitrile, 25 μM, room temperature';
update public.entries set conditions = 'MeCN matrix, 77 K (neutral)' where conditions = 'CH3CN solid matrix, 77 K (neutral form of the catalyst, no base)';
update public.entries set conditions = 'Cryogenic (solvent unstated)' where conditions = 'Cryogenic temperature; solvent or glass not given';
update public.entries set conditions = 'MCH glass, 77 K' where conditions = 'Methylcyclohexane glass, 77 K';
update public.entries set conditions = 'rt' where conditions = 'Room temperature (stated for all experimental values in the caption of Figure 3)';
update public.entries set conditions = 'MeI' where conditions = 'Solution in methyl iodide';
update public.entries set conditions = 'Solution, rt (solvent in SI)' where conditions = 'Solution, room temperature; solvent given in the SI';
update public.entries set conditions = 'Not stated' where conditions = 'Solvent model not stated in the table footnote';
update public.entries set conditions = 'CHCl3, 30 atm O2' where conditions = 'Under high-pressure O2; the example spectra are in CHCl3 at 30 atm O2';

-- seed.sql rows
update public.entries set method = 'S0→T1 spectroscopy (quoted estimate)' where method = 'Spectroscopic S0→T1 excitation energy, quoted as the best estimate. This text does not describe the original measurement; it is in the cited references (refs 1 and 2 of the paper).';
update public.entries set method = 'S0→T1 vertical spectroscopy (quoted)' where method = 'Spectroscopic vertical excitation energy, quoted value. The original measurement is in the cited references (ref. 3, Hammond et al. 1964).';
update public.entries set method = 'EELS (vibrationally resolved)' where method = 'Low-energy electron-energy-loss spectroscopy (EELS), vibrationally resolved bands';
update public.entries set method = 'PAC' where method = 'Time-resolved photoacoustic calorimetry (PAC)' and import_key like 'seed:%';
update public.entries set method = 'DFT, ωB97XD/aug-cc-pVTZ' where method = 'DFT, ωB97XD/aug-cc-pVTZ, electronic energy';
update public.entries set conditions = 'Not stated' where conditions in ('Not given in the passage', 'Not given in the abstract');
update public.entries set conditions = 'Not stated (details in SI)' where conditions = 'Details (solvent model, ZPE) are in the Supplementary Materials, not read yet';
update public.entries set conditions = 'MeOH' where conditions = 'Methanol; the text says results in cyclohexane are almost identical';
update public.entries set conditions = 'CH2Cl2' where conditions = 'CH2Cl2 (solvent model)';
