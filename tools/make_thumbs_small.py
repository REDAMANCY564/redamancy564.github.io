"""Small homepage thumbnails: assets/thumbs/small/<tool>.webp (192 x 128, shown at 96 x 64 or 64 x 43).

Each is a crop of the tool's projects-page screenshot (assets/thumbs/<tool>.webp, 600 x 450) around the part
that is recognisable at this size (chart, map, molecule). Run again after replacing a screenshot; check the
boxes if the screenshot's layout changed.

    python tools/make_thumbs_small.py
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC, OUT = ROOT / "assets/thumbs", ROOT / "assets/thumbs/small"
SIZE = (192, 128)
# (left, top, right, bottom) in the 600 x 450 screenshot, 3:2
BOXES = {
    "gcms-interpreter": (175, 235, 415, 395),    # flavor profile radar under the ranking table
    "ingredient-finder": (10, 35, 310, 235),     # first result card: structure, name, predicted odor
    "odor-predictor": (90, 15, 330, 175),        # diacetyl with atom contributions and contribution chips
    "flavor-improver": (300, 10, 552, 178),      # best score by number of trials (the optimization curve)
    "odor-map": (0, 40, 330, 260),               # coloured clusters with region labels
    "taste-predictor": (265, 15, 565, 215),      # predicted taste bars
    "flavor-kb": (10, 15, 280, 195),             # food card with key odorant tags
}


def main():
    OUT.mkdir(exist_ok=True)
    for name, box in BOXES.items():
        w, h = box[2] - box[0], box[3] - box[1]
        assert abs(w * SIZE[1] - h * SIZE[0]) <= SIZE[0], f"{name}: box is not 3:2"
        im = Image.open(SRC / f"{name}.webp").convert("RGB").crop(box).resize(SIZE, Image.LANCZOS)
        im.save(OUT / f"{name}.webp", "WEBP", quality=82, method=6)
        print(name, (OUT / f"{name}.webp").stat().st_size, "bytes")


if __name__ == "__main__":
    main()
