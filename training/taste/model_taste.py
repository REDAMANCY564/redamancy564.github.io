"""Taste GCN: the odor GCN (training/model.py OdorGNN) with readout options (case-fix-3).

  pools        any of "mean", "max", "sum" (concatenated in this order)
  n_desc       number of whole-molecule descriptors (descriptors.py, z-scored) concatenated
               to the pooled vector; 0 = none (then the model is OdorGNN with mean + max)
The ONNX model takes the descriptors as an extra input D [B, n_desc] when n_desc > 0.
"""
import torch
from torch import nn


class TasteGNN(nn.Module):
    def __init__(self, num_features, num_labels, hidden=128, num_layers=3, dropout=0.2,
                 pools=("mean", "max"), n_desc=0):
        super().__init__()
        dims = [num_features] + [hidden] * num_layers
        self.convs = nn.ModuleList(nn.Linear(a, b) for a, b in zip(dims[:-1], dims[1:]))
        self.dropout = nn.Dropout(dropout)
        self.pools = list(pools)
        self.n_desc = n_desc
        d_in = len(self.pools) * hidden + n_desc
        self.head = nn.Sequential(
            nn.Linear(d_in, 2 * hidden), nn.ReLU(), nn.Dropout(dropout),
            nn.Linear(2 * hidden, num_labels),
        )

    def forward(self, X, A, mask, D=None):
        """X [B,N,F], A [B,N,N], mask [B,N], D [B,n_desc] -> logits [B,L]."""
        m = mask.unsqueeze(-1)
        H = X
        for conv in self.convs:
            H = torch.relu(A @ conv(H)) * m
            H = self.dropout(H)
        parts = []
        for p in self.pools:
            if p == "mean":
                parts.append(H.sum(dim=1) / m.sum(dim=1).clamp(min=1.0))
            elif p == "max":
                parts.append(H.max(dim=1).values)  # H >= 0, padding 0
            elif p == "sum":
                parts.append(H.sum(dim=1))
        if self.n_desc:
            parts.append(D)
        return self.head(torch.cat(parts, dim=-1))
