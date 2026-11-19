"""Odor-map training animation (stage 3a): how the odor map takes shape while the MPNN trains.

Frames come from the deployed seed's checkpoints saved by train_mpnn.py final
(checkpoints/mpnn_frames/seed2): epochs 0..10, 12, 14, ..., best epoch (26). For each keyframe the
model predicts the 5,072 library molecules; the input to UMAP is processed exactly like the online
map (build_maps.py): probabilities rounded to 1/255, cosine distance, n_neighbors 30, min_dist 0.3,
random_state 42.

The last frame is NOT recomputed: it is the online odor map itself (training/data/odormap/maps.npz,
the source of odor-map/data/coords.bin), so the end of the video matches the tool page exactly.
Earlier frames are computed backwards and must not simply inherit the final clusters; the check
(user request 2026-11-18) compares, for every frame,
  (a) on the 2-D frame: share of each molecule's 15 nearest neighbours with the same colour
      (final main predicted descriptor, the 10 page colours + other), and
  (b) in that epoch's 138-d prediction space (cosine): the same share.
If (a) is clearly above (b) in early frames, the starting coordinates leaked into the frame.

Variants (python make_training_video.py frames):
  chain        UMAP of frame t initialised with frame t+1 (default optimisation length)
  chain_long   the same with n_epochs = 1000
  indep        UMAP of each frame on its own (spectral init, random_state 42), then rotated /
               reflected / scaled / shifted onto frame t+1 by orthogonal Procrustes (no
               information from later frames enters the layout itself)
Output: training/data/odormap/training_frames.npz, training_check.json

Curve under the video (python make_training_video.py curve): validation macro AUROC for every epoch
(epochs 1-46 from mpnn_results.json histories of the deployed seed, epoch 0 computed from its
checkpoint) and the change in predictions per epoch: mean absolute difference of the 5,072 library
molecules' predicted probabilities between consecutive saved checkpoints (all of them, also after the
best epoch up to early stopping), divided by the number of epochs between them. Written into
odor-map/data/training_frames.json ("curve"); run after "video", which rewrites that file.

Rendering (python make_training_video.py video [variant]):
  keyframes are scaled like make_site_data.scale(); the last frame is decoded from coords.bin itself
  (checked: scale(maps.npz) quantized == coords.bin byte for byte). Going backwards from the last frame,
  every keyframe is rotated, uniformly scaled (to the same spread) and shifted as a whole onto the
  (already aligned) next one (no reflection; the relative positions of the points are unchanged), which removes global turning and
  drift between frames; the last frame is not touched. Between keyframes positions are interpolated with
  ease-in-out, 0.5 s per training epoch (so a step of 2 epochs after epoch 10 takes 1 s) at 30 fps, 1 s
  still at the start and 2.5 s at the end.
  Dots as on the page: radius 2.3 px at 900 px, other grey (alpha 0.55) first, then the 10 colours
  (alpha 0.82) in map.json order, white background, drawn at 2x and downsampled.
  Writes odor-map/media/training.mp4 (H.264, yuv420p, faststart), odor-map/media/training-poster.webp
  (the last frame), odor-map/data/training_frames.json (time -> epoch for the page caption) and
  keyframe PNGs to training/data/odormap/keyframes/ for review.
"""
import json
import sys
from pathlib import Path

import imageio_ffmpeg
import numpy as np
import torch
from PIL import Image, ImageDraw
import umap
from scipy.linalg import orthogonal_procrustes
from sklearn.neighbors import NearestNeighbors

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "training"))
from featurize_mpnn import NUM_BOND_FEATURES, featurize_many  # noqa: E402
from model_mpnn import OdorMPNN  # noqa: E402
from odormap.build_maps import PARAMS, SEED  # noqa: E402

DATA = ROOT / "training" / "data"
FRAMES_DIR = ROOT / "training" / "checkpoints" / "mpnn_frames" / "seed2"
CKPT = ROOT / "training" / "checkpoints" / "odor_mpnn.pt"
OUT = DATA / "odormap"
K = 15


def keyframe_epochs(best):
    return [e for e in list(range(0, 11)) + list(range(12, best + 1, 2)) if e <= best]


def predict_frames(epochs):
    lib = json.loads((DATA / "ingredient" / "library.json").read_text(encoding="utf-8"))["molecules"]
    X, E, M = featurize_many([r["smiles"] for r in lib])
    ck = torch.load(CKPT, map_location="cpu")
    model = OdorMPNN(ck["num_features"], NUM_BOND_FEATURES, len(ck["labels"]), **ck["config"]).eval()
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(dev)
    out = {}
    for e in epochs:
        model.load_state_dict(torch.load(FRAMES_DIR / f"epoch{e:03d}.pt", map_location=dev))
        with torch.no_grad():
            P = np.concatenate([torch.sigmoid(model(*(torch.from_numpy(a[i:i + 256]).to(dev) for a in (X, E, M))))
                                .cpu().numpy() for i in range(0, len(X), 256)])
        out[e] = np.round(P * 255) / 255          # as build_maps.py
    return out


def colours():
    """Per molecule: index of its colour class on the page (map.json colours by probs.bin top-1), 10 = other."""
    site = ROOT / "ingredient-finder" / "data"
    labels = [l["id"] for l in json.loads((site / "library.json").read_text(encoding="utf-8"))["labels"]]
    P = np.frombuffer((site / "probs.bin").read_bytes(), np.uint8).reshape(-1, len(labels))
    cols = json.loads((ROOT / "odor-map" / "data" / "map.json").read_text(encoding="utf-8"))["colours"]
    cat = {labels.index(c): k for k, c in enumerate(cols)}
    return np.array([cat.get(int(j), len(cols)) for j in P.argmax(1)])


def same_colour_share(X, col, metric):
    nn = NearestNeighbors(n_neighbors=K + 1, metric=metric).fit(X)
    idx = nn.kneighbors(X, return_distance=False)[:, 1:]
    return float((col[idx] == col[:, None]).mean())


def run_umap(P, init=None, n_epochs=None):
    kw = dict(PARAMS["odor"])
    return umap.UMAP(n_components=2, random_state=SEED, init=init if init is not None else "spectral",
                     n_epochs=n_epochs, **kw).fit_transform(P)


def rigid_onto(A, B):
    """Rotate (best least-squares rotation, no reflection), scale and shift A as a whole onto B.
    The scale makes A's spread (root mean square distance from the centre) equal to B's; the least-squares
    scale would shrink frames that match the next one poorly (the early epochs) towards their centre."""
    a0, b0 = A - A.mean(0), B - B.mean(0)
    U, S, Vt = np.linalg.svd(a0.T @ b0)
    d = np.sign(np.linalg.det(U @ Vt))
    R = U @ np.diag([1.0, d]) @ Vt
    scale = np.sqrt((b0 ** 2).sum() / (a0 ** 2).sum())
    return a0 @ R * scale + B.mean(0)


def procrustes_onto(A, B):
    """Similarity transform of A (rotation/reflection, uniform scale, shift) that best matches B."""
    a0, b0 = A - A.mean(0), B - B.mean(0)
    R, s = orthogonal_procrustes(a0, b0)
    scale = s / (a0 ** 2).sum()
    return a0 @ R * scale + B.mean(0)


def frames():
    ck = torch.load(CKPT, map_location="cpu")
    best = int(json.loads((ROOT / "training" / "mpnn_results.json").read_text(encoding="utf-8"))["mpnn"]["seeds"][2]["best_epoch"])
    assert ck["seed"] == 2
    epochs = keyframe_epochs(best)
    probs = predict_frames(epochs)
    final_probs = np.round(np.load(DATA / "ingredient" / "features.npz")["probs"] * 255) / 255
    # the best checkpoint is the deployed model: at most one rounding step apart (GPU PyTorch vs the ONNX run
    # behind features.npz); the last frame uses exactly the online input
    assert np.abs(probs[best] - final_probs).max() <= 1 / 255 + 1e-6, "best checkpoint is not the deployed model"
    probs[best] = final_probs
    online = np.load(OUT / "maps.npz")["odor"].astype(np.float64)
    col = colours()

    variants = {}
    for name in ("chain", "chain_long", "indep"):
        Y = {best: online}
        for e in reversed(epochs[:-1]):
            nxt = Y[epochs[epochs.index(e) + 1]]
            if name == "chain":
                Y[e] = run_umap(probs[e], init=nxt)
            elif name == "chain_long":
                Y[e] = run_umap(probs[e], init=nxt, n_epochs=1000)
            else:
                Y[e] = procrustes_onto(run_umap(probs[e]), nxt)
            print(f"{name} epoch {e} done", flush=True)
        variants[name] = Y

    report = {"k": K, "epochs": epochs, "colour_classes": "10 page colours + other (final main predicted descriptor)",
              "b_highdim_cosine": {}, "a_2d": {n: {} for n in variants}}
    for e in epochs:
        report["b_highdim_cosine"][e] = round(same_colour_share(probs[e], col, "cosine"), 4)
        for n, Y in variants.items():
            report["a_2d"][n][e] = round(same_colour_share(Y[e], col, "euclidean"), 4)
    (OUT / "training_check.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    np.savez_compressed(OUT / "training_frames.npz", epochs=np.array(epochs), colour=col,
                        **{f"{n}_{e}": Y[e] for n, Y in variants.items() for e in epochs})
    print(f"{'epoch':>5} {'(b) 138-d':>10} " + " ".join(f"{n:>11}" for n in variants))
    for e in epochs:
        print(f"{e:5d} {report['b_highdim_cosine'][e]:10.3f} " + " ".join(f"{report['a_2d'][n][e]:11.3f}" for n in variants))


SIZE, SS, FPS, STEP_S, HOLD_START_S, HOLD_END_S = 800, 2, 30, 0.5, 1.0, 2.5
MARGIN = 0.04
OTHER = "#adb5bd"


def scale(xy):   # same as make_site_data.scale
    lo, hi = xy.min(0), xy.max(0)
    span = (hi - lo).max()
    out = (xy - lo) / span
    out += (1 - (hi - lo) / span) / 2
    return out


def render(xy01, col, hexes):
    W = SIZE * SS
    im = Image.new("RGBA", (W, W), (255, 255, 255, 255))
    r = 2.3 * SIZE / 900 * SS
    pts = (MARGIN + xy01 * (1 - 2 * MARGIN)) * W
    for cls, colour, alpha in [(len(hexes), OTHER, 0.55)] + [(k, h, 0.82) for k, h in enumerate(hexes)]:
        layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        rgb = tuple(int(colour[i:i + 2], 16) for i in (1, 3, 5))
        for i in np.flatnonzero(col == cls):
            x, y = pts[i]
            d.ellipse((x - r, y - r, x + r, y + r), fill=rgb + (255,))
        a = layer.getchannel("A").point(lambda v: int(v * alpha))
        layer.putalpha(a)
        im = Image.alpha_composite(im, layer)
    return im.convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)


def ease(t):
    return t * t * (3 - 2 * t)


def video(variant="chain"):
    z = np.load(OUT / "training_frames.npz")
    epochs = [int(e) for e in z["epochs"]]
    col = z["colour"]
    meta = json.loads((ROOT / "odor-map" / "data" / "map.json").read_text(encoding="utf-8"))
    hexes = [meta["colour_hex"][c] for c in meta["colours"]]
    n = meta["n"]
    coords = np.frombuffer((ROOT / "odor-map" / "data" / "coords.bin").read_bytes(), "<u2").reshape(2, n, 2)[0]
    online = np.load(OUT / "maps.npz")["odor"].astype(np.float64)
    assert np.array_equal(np.round(scale(online) * 65535).astype("<u2"), coords), "last frame != coords.bin"
    # the page draws the (x, y) of coords.bin with y downwards, as here
    key = {e: scale(z[f"{variant}_{e}"]) for e in epochs}
    key[epochs[-1]] = coords.astype(np.float64) / 65535
    for a, b in zip(reversed(epochs[:-1]), reversed(epochs[1:])):   # align backwards from the fixed last frame
        key[a] = rigid_onto(key[a], key[b])
    assert np.array_equal(np.round(key[epochs[-1]] * 65535).astype("<u2"), coords), "last frame changed"
    lo = min(key[e].min() for e in epochs); hi = max(key[e].max() for e in epochs)
    print(f"aligned coordinates range {lo:.3f} .. {hi:.3f} (drawn area 0..1 plus {MARGIN} margin)")
    kdir = OUT / "keyframes"
    kdir.mkdir(exist_ok=True)
    for e in epochs:
        render(key[e], col, hexes).save(kdir / f"{variant}_epoch{e:03d}.png")

    media = ROOT / "odor-map" / "media"
    media.mkdir(exist_ok=True)
    plan = [(epochs[0], epochs[0], 0.0)] * int(HOLD_START_S * FPS)
    starts = []   # time each step begins
    for a, b in zip(epochs[:-1], epochs[1:]):
        per = int(round(STEP_S * (b - a) * FPS))   # 0.5 s per training epoch
        starts.append((len(plan) / FPS, per / FPS))
        plan += [(a, b, (k + 1) / per) for k in range(per)]
    plan += [(epochs[-1], epochs[-1], 0.0)] * int(HOLD_END_S * FPS)
    w = imageio_ffmpeg.write_frames(str(media / "training.mp4"), (SIZE, SIZE), fps=FPS, codec="libx264",
                                    quality=None, bitrate=None, pix_fmt_out="yuv420p", macro_block_size=16,
                                    output_params=["-crf", "30", "-preset", "slow", "-movflags", "+faststart",
                                                   "-tune", "animation"])
    w.send(None)
    for a, b, t in plan:
        xy = key[a] if a == b else key[a] + (key[b] - key[a]) * ease(t)
        w.send(np.asarray(render(xy, col, hexes)).tobytes())
    w.close()
    render(key[epochs[-1]], col, hexes).save(media / "training-poster.webp", "WEBP", quality=82, method=6)
    # caption: the epoch shown from each time on (the step to keyframe b counts as b once it is half done)
    times = [{"t": round(starts[i - 1][0] + starts[i - 1][1] / 2, 3) if i else 0.0, "epoch": e} for i, e in enumerate(epochs)]
    info = {"fps": FPS, "duration_s": round(len(plan) / FPS, 3), "best_epoch": epochs[-1], "keyframes": times,
            "variant": variant, "source": "training/odormap/make_training_video.py"}
    (ROOT / "odor-map" / "data" / "training_frames.json").write_text(json.dumps(info), encoding="utf-8")
    print(f"video {(media / 'training.mp4').stat().st_size / 1e6:.2f} MB, {len(plan)} frames, "
          f"{len(plan) / FPS:.1f} s; poster {(media / 'training-poster.webp').stat().st_size / 1e3:.0f} kB")


def curve():
    sys.path.insert(0, str(ROOT / "training"))
    from evaluate import load_split, macro_auroc
    res = json.loads((ROOT / "training" / "mpnn_results.json").read_text(encoding="utf-8"))
    seed = res["mpnn"]["seeds"][2]
    assert seed["seed"] == 2
    best, stopped = int(seed["best_epoch"]), int(seed["epochs_run"])
    hist = res["histories"]["seed2"]
    saved = sorted(int(p.stem[5:]) for p in FRAMES_DIR.glob("epoch*.pt"))
    assert saved[-1] == stopped and best in saved
    # epoch 0 (untrained) on the validation set, from its checkpoint
    smiles, _, Y, split, _ = load_split()
    va = split == "valid"
    Xv, Ev, Mv = featurize_many(list(np.array(smiles)[va]))
    ck = torch.load(CKPT, map_location="cpu")
    model = OdorMPNN(ck["num_features"], NUM_BOND_FEATURES, len(ck["labels"]), **ck["config"]).eval()
    model.load_state_dict(torch.load(FRAMES_DIR / "epoch000.pt", map_location="cpu"))
    with torch.no_grad():
        p0 = torch.sigmoid(model(*(torch.from_numpy(a) for a in (Xv, Ev, Mv)))).numpy()
    auc = [[0, round(float(macro_auroc(Y[va], p0)), 4)]] + [[int(h[0]), round(float(h[2]), 4)] for h in hist]
    # raw probabilities (not rounded) of the library molecules at every saved checkpoint
    lib = json.loads((DATA / "ingredient" / "library.json").read_text(encoding="utf-8"))["molecules"]
    X, E, M = featurize_many([r["smiles"] for r in lib])
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(dev)
    P = {}
    for e in saved:
        model.load_state_dict(torch.load(FRAMES_DIR / f"epoch{e:03d}.pt", map_location=dev))
        with torch.no_grad():
            P[e] = np.concatenate([torch.sigmoid(model(*(torch.from_numpy(a[i:i + 256]).to(dev) for a in (X, E, M))))
                                   .cpu().numpy() for i in range(0, len(X), 256)]).astype(np.float64)
    change = [[b, round(float(np.abs(P[b] - P[a]).mean()) / (b - a), 5)] for a, b in zip(saved[:-1], saved[1:])]
    switch = [[b, round(float((P[a].argmax(1) != P[b].argmax(1)).mean()), 3)] for a, b in zip(saved[:-1], saved[1:])]
    path = ROOT / "odor-map" / "data" / "training_frames.json"
    info = json.loads(path.read_text(encoding="utf-8"))
    info["curve"] = {"auroc": auc, "change": change, "top1_switch": switch, "best": best, "stopped": stopped,
                     "patience": stopped - best, "n_molecules": len(lib),
                     "change_definition": "mean |p_b - p_a| over molecules x 138 descriptors, divided by b - a"}
    path.write_text(json.dumps(info), encoding="utf-8")
    print("curve: auroc", auc[0], auc[best], auc[-1], "change", change[:3], change[-2:])


if __name__ == "__main__":
    {"frames": frames, "video": video, "curve": curve}[sys.argv[1]](*sys.argv[2:])
