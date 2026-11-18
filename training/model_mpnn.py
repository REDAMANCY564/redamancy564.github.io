"""Bond-aware message passing network (dense tensors, pure PyTorch, ONNX-exportable).

Follows the idea of the message passing GNN in Lee et al., Science 381, 999 (2023):
messages depend on the neighbour state and on the bond. Not a reproduction.

  h0_i      = ReLU(W_in x_i)
  m_ij      = ReLU(U h_j + V e_ij + b)          for bonded pairs (i, j)
  M_i       = sum_j m_ij                         (plain sum over bonded neighbours)
  update    "res": h_i <- h_i + ReLU(W [h_i, M_i] + c)
            "gru": h_i <- GRU(input M_i, hidden h_i)   (written out with Linear ops)
  then padded atoms are zeroed and dropout is applied, as in model.py.
  readout   mean over real atoms + max over real atoms (padding masked to -1e9) -> 2H
  head      Linear 2H->2H, ReLU, Dropout, Linear 2H->L (logits; sigmoid added at export)

After layer t an atom state depends only on atoms within t bonds.
Inputs: X [B,N,F], E [B,N,N,FB], mask [B,N]. Adjacency = E.sum(-1) > 0.
"""
import torch
from torch import nn


class GRUUpdate(nn.Module):
    """GRU cell (same equations as torch.nn.GRUCell) using only Linear/sigmoid/tanh."""

    def __init__(self, hidden):
        super().__init__()
        self.x2h = nn.Linear(hidden, 3 * hidden)
        self.h2h = nn.Linear(hidden, 3 * hidden)

    def forward(self, h, m):
        xr, xz, xn = self.x2h(m).chunk(3, dim=-1)
        hr, hz, hn = self.h2h(h).chunk(3, dim=-1)
        r = torch.sigmoid(xr + hr)
        z = torch.sigmoid(xz + hz)
        n = torch.tanh(xn + r * hn)
        return (1 - z) * n + z * h


class ResUpdate(nn.Module):
    def __init__(self, hidden):
        super().__init__()
        self.lin = nn.Linear(2 * hidden, hidden)

    def forward(self, h, m):
        return h + torch.relu(self.lin(torch.cat([h, m], dim=-1)))


class OdorMPNN(nn.Module):
    def __init__(self, num_features, num_bond_features, num_labels, hidden=128, num_layers=4,
                 update="res", dropout=0.2):
        super().__init__()
        self.embed = nn.Linear(num_features, hidden)
        self.msg_node = nn.ModuleList(nn.Linear(hidden, hidden, bias=False) for _ in range(num_layers))
        self.msg_bond = nn.ModuleList(nn.Linear(num_bond_features, hidden) for _ in range(num_layers))
        upd = {"res": ResUpdate, "gru": GRUUpdate}[update]
        self.updates = nn.ModuleList(upd(hidden) for _ in range(num_layers))
        self.dropout = nn.Dropout(dropout)
        self.head = nn.Sequential(
            nn.Linear(2 * hidden, 2 * hidden), nn.ReLU(), nn.Dropout(dropout),
            nn.Linear(2 * hidden, num_labels),
        )

    def layers(self, X, E, mask):
        """Yields atom states h0, h1, ..., hT (each [B,N,H], padding rows 0)."""
        m = mask.unsqueeze(-1)
        adj = (E.sum(dim=-1, keepdim=True) > 0).to(X.dtype)          # [B,N,N,1]
        H = torch.relu(self.embed(X)) * m
        H = self.dropout(H)
        yield H
        for node, bond, upd in zip(self.msg_node, self.msg_bond, self.updates):
            # message from j to i: ReLU(U h_j + V e_ij + b), kept only where i-j is a bond
            msg = torch.relu(node(H).unsqueeze(1) + bond(E)) * adj    # [B,i,j,H]
            M = msg.sum(dim=2)
            H = upd(H, M) * m
            H = self.dropout(H)
            yield H

    def readout(self, H, mask):
        m = mask.unsqueeze(-1)
        n_atoms = m.sum(dim=1).clamp(min=1.0)
        mean_pool = H.sum(dim=1) / n_atoms
        max_pool = H.masked_fill(m == 0, -1e9).max(dim=1).values
        return torch.cat([mean_pool, max_pool], dim=-1)

    def forward(self, X, E, mask):
        """X [B,N,F], E [B,N,N,FB], mask [B,N] -> logits [B,L]."""
        for H in self.layers(X, E, mask):
            pass
        return self.head(self.readout(H, mask))
