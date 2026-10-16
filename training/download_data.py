"""Download the curated GoodScents + Leffingwell (GS-LF) merged dataset from OpenPOM.

Source: https://github.com/BioMachineLearning/openpom (pinned commit below).
Data terms: Leffingwell is CC BY-NC (non-commercial); GoodScents is scraped from
thegoodscentscompany.com with no open license. The raw file stays in training/data/
and is NOT committed to the public repo.
"""
import hashlib
import urllib.request
from pathlib import Path

COMMIT = "8c345c1451bc3660c1e38575814d793beff2ed9f"
URL = (
    "https://raw.githubusercontent.com/BioMachineLearning/openpom/"
    f"{COMMIT}/openpom/data/curated_datasets/curated_GS_LF_merged_4983.csv"
)
DATA_DIR = Path(__file__).parent / "data"
OUT = DATA_DIR / "curated_GS_LF_merged_4983.csv"


def main():
    DATA_DIR.mkdir(exist_ok=True)
    if not OUT.exists():
        print(f"Downloading {URL}")
        urllib.request.urlretrieve(URL, OUT)
    sha = hashlib.sha256(OUT.read_bytes()).hexdigest()
    print(f"Saved {OUT} ({OUT.stat().st_size:,} bytes, sha256={sha[:16]}...)")


if __name__ == "__main__":
    main()
