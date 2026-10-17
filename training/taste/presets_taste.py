"""Preset molecules for the taste page (dairy-related; user-approved 2026-10-17).
SMILES validated with RDKit; names and CIDs checked against PubChem.
Fields: id, English name, Chinese name, SMILES (as sold / as found, salts kept), PubChem CID.
"""
PRESETS = [
    ("lactose", "Lactose", "乳糖", "OC[C@H]1O[C@@H](O[C@H]2[C@H](O)[C@@H](O)C(O)O[C@@H]2CO)[C@H](O)[C@@H](O)[C@H]1O", 440995),
    ("galactose", "D-Galactose", "D-半乳糖", "OC[C@H]1OC(O)[C@H](O)[C@@H](O)[C@H]1O", 6036),
    ("glucose", "D-Glucose", "D-葡萄糖", "OC[C@H]1OC(O)[C@H](O)[C@@H](O)[C@@H]1O", 5793),
    ("sucrose", "Sucrose", "蔗糖", "OC[C@H]1O[C@H](O[C@]2(CO)O[C@H](CO)[C@@H](O)[C@@H]2O)[C@H](O)[C@@H](O)[C@@H]1O", 5988),
    ("msg", "Monosodium glutamate", "谷氨酸钠", "N[C@@H](CCC(=O)O)C(=O)[O-].[Na+]", 23672308),
    ("imp", "Disodium inosinate (IMP)", "5'-肌苷酸二钠", "O=c1[nH]cnc2c1ncn2[C@@H]1O[C@H](COP(=O)([O-])[O-])[C@@H](O)[C@H]1O.[Na+].[Na+]", 135414245),
    ("lactic-acid", "L-Lactic acid", "L-乳酸", "C[C@H](O)C(=O)O", 107689),
    ("citric-acid", "Citric acid", "柠檬酸", "OC(=O)CC(O)(CC(=O)O)C(=O)O", 311),
    ("leucine", "L-Leucine", "L-亮氨酸", "CC(C)C[C@H](N)C(=O)O", 6106),
    ("phenylalanine", "L-Phenylalanine", "L-苯丙氨酸", "N[C@@H](Cc1ccccc1)C(=O)O", 6140),
    ("caffeine", "Caffeine", "咖啡因", "Cn1c(=O)c2c(ncn2C)n(C)c1=O", 2519),
    ("vanillin", "Vanillin", "香兰素", "COc1cc(C=O)ccc1O", 1183),
    ("butyric-acid", "Butyric acid", "丁酸", "CCCC(=O)O", 264),
]
