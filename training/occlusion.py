"""Occlusion attribution for the dense-adjacency GNN (odor and taste models).

For a molecule with n atoms, atom i is "occluded" by removing it from the graph: its
feature row and mask are zeroed, its bonds are dropped and the adjacency of the remaining
atoms is renormalized (D^-1/2 (A + I) D^-1/2 without atom i), exactly like padding.
contribution[i, l] = p_l(full molecule) - p_l(molecule without atom i)
Positive: the atom pushes the prediction up. All n + 1 inputs run as one batch.

The browser repeats this in odor-predictor/engine.js (occlusion); the parity pages compare.
"""
import numpy as np


def occlusion_batch(X, A, M):
    """X [64,F], A [64,64], M [64] of one molecule -> batched (n+1) inputs; row 0 = full."""
    n = int(M.sum())
    raw = (A[:n, :n] > 0).astype(np.float64)  # bonds + self loops
    Xs, As, Ms = [X], [A], [M]
    for i in range(n):
        r = raw.copy()
        r[i, :] = 0.0
        r[:, i] = 0.0
        deg = r.sum(axis=1)
        d = np.zeros(n)
        keep = deg > 0
        d[keep] = 1.0 / np.sqrt(deg[keep])
        Ai = np.zeros_like(A)
        Ai[:n, :n] = r * d[:, None] * d[None, :]
        Xi = X.copy()
        Xi[i] = 0.0
        Mi = M.copy()
        Mi[i] = 0.0
        Xs.append(Xi)
        As.append(Ai)
        Ms.append(Mi)
    return np.stack(Xs), np.stack(As), np.stack(Ms)


def contributions(run, X, A, M):
    """run(X, A, M) -> probs [B, L]. Returns (probs [L], contrib [n, L])."""
    P = run(*occlusion_batch(X, A, M))
    return P[0], P[0][None, :] - P[1:]
