"""Small dense-adjacency GCN in pure PyTorch (ONNX-exportable, no PyG)."""
import torch
from torch import nn


class OdorGNN(nn.Module):
    def __init__(self, num_features, num_labels, hidden=128, num_layers=3, dropout=0.2):
        super().__init__()
        dims = [num_features] + [hidden] * num_layers
        self.convs = nn.ModuleList(nn.Linear(a, b) for a, b in zip(dims[:-1], dims[1:]))
        self.dropout = nn.Dropout(dropout)
        self.head = nn.Sequential(
            nn.Linear(2 * hidden, 2 * hidden), nn.ReLU(), nn.Dropout(dropout),
            nn.Linear(2 * hidden, num_labels),
        )

    def forward(self, X, A, mask):
        """X [B,N,F], A [B,N,N], mask [B,N] -> logits [B,L]."""
        m = mask.unsqueeze(-1)
        H = X
        for conv in self.convs:
            # H = ReLU(A @ H @ W + b), padded atoms zeroed after each layer
            H = torch.relu(A @ conv(H)) * m
            H = self.dropout(H)
        n_atoms = m.sum(dim=1).clamp(min=1.0)
        mean_pool = H.sum(dim=1) / n_atoms
        max_pool = H.max(dim=1).values  # H >= 0 and padding is 0, so no -inf masking needed
        return self.head(torch.cat([mean_pool, max_pool], dim=-1))
