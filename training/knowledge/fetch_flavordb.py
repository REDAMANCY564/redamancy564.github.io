"""Download FlavorDB2 entity records (food ingredients with their molecules).

FlavorDB2 (Garg et al., Nucleic Acids Res. 2018; https://cosylab.iiitd.edu.in/flavordb2/)
is licensed CC BY-NC-SA 3.0. There is no bulk download, so this script requests each
entity once (1 request per second) and caches the raw JSON in training/data/flavordb_raw/,
which is git-ignored. Re-running skips entities already cached.
"""
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://cosylab.iiitd.edu.in/flavordb2/entities_json?id={}"
RAW_DIR = Path(__file__).resolve().parent.parent / "data" / "flavordb_raw"
MAX_ID = 1100
STOP_AFTER_MISSING = 60   # stop after this many consecutive 404s
DELAY = 1.0
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; redamancy564.github.io flavor-kb builder)"}


def main():
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    missing = fetched = 0
    for i in range(MAX_ID + 1):
        out = RAW_DIR / f"entity_{i}.json"
        if out.exists():
            missing = 0
            continue
        req = urllib.request.Request(BASE.format(i), headers=HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            json.loads(data)  # validate before caching
            out.write_bytes(data)
            fetched += 1
            missing = 0
        except urllib.error.HTTPError as e:
            if e.code == 404:
                missing += 1
                if missing >= STOP_AFTER_MISSING:
                    print(f"Stopping at id {i}: {missing} consecutive 404s")
                    break
            else:
                print(f"id {i}: HTTP {e.code}")
        except Exception as e:  # network hiccup: report and continue, re-run picks it up
            print(f"id {i}: {e}")
        if i % 50 == 0:
            print(f"id {i} | fetched {fetched}", flush=True)
        time.sleep(DELAY)
    print(f"Done. Cached files: {len(list(RAW_DIR.glob('entity_*.json')))}")


if __name__ == "__main__":
    main()
