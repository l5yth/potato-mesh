# Copyright © 2025-26 l5yth & contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""RFC 8032 Ed25519 arithmetic: a test oracle for the small-order blocklist.

Derives, from the curve constants of RFC 8032 section 5.1 alone, every 32-byte
encoding of a point of small order (order 1, 2, 4 or 8), so the ingestor's
blocklist (libsodium's ``ge25519_has_small_order`` list, SPEC SG4) is checked
against first principles rather than copied from it.  Pure Python affine
arithmetic, slow and not constant-time: for tests only.
"""

from __future__ import annotations

P = 2**255 - 19
"""The field prime ``p`` (RFC 8032 section 5.1)."""

D = -121665 * pow(121666, P - 2, P) % P
"""The curve constant ``d = -121665/121666`` (RFC 8032 section 5.1)."""

L = 2**252 + 27742317777372353535851937790883648493
"""The prime order of the base point; the curve's order is ``8 * L``."""

SQRT_M1 = pow(2, (P - 1) // 4, P)
"""A square root of ``-1`` modulo ``p`` (RFC 8032 section 5.1.3)."""

IDENTITY = (0, 1)
"""The neutral point ``(x, y) = (0, 1)``."""


def point_add(a: tuple[int, int], b: tuple[int, int]) -> tuple[int, int]:
    """Add two points of ``-x^2 + y^2 = 1 + d x^2 y^2`` (RFC 8032 section 5.1.4).

    Parameters:
        a: First point ``(x, y)``.
        b: Second point ``(x, y)``.

    Returns:
        The sum ``a + b``.
    """
    (x1, y1), (x2, y2) = a, b
    t = D * x1 * x2 * y1 * y2 % P
    x3 = (x1 * y2 + y1 * x2) * pow(1 + t, P - 2, P) % P
    y3 = (y1 * y2 + x1 * x2) * pow(1 - t, P - 2, P) % P
    return x3, y3


def scalar_mult(k: int, point: tuple[int, int]) -> tuple[int, int]:
    """Return ``[k] point`` by double-and-add.

    Parameters:
        k: Non-negative scalar.
        point: Point ``(x, y)``.

    Returns:
        The multiple.
    """
    result, addend = IDENTITY, point
    while k:
        if k & 1:
            result = point_add(result, addend)
        addend = point_add(addend, addend)
        k >>= 1
    return result


def curve_x(y: int) -> int | None:
    """Return an ``x`` with ``(x, y)`` on the curve (RFC 8032 section 5.1.3).

    Parameters:
        y: Coordinate below ``p``.

    Returns:
        One of the two square roots, or ``None`` when no point has this ``y``.
    """
    u, v = (y * y - 1) % P, (D * y * y + 1) % P
    x = u * pow(v, 3, P) * pow(u * pow(v, 7, P), (P - 5) // 8, P) % P
    if v * x * x % P == u:
        return x
    if v * x * x % P == -u % P:
        return x * SQRT_M1 % P
    return None


def small_order_points() -> set[tuple[int, int]]:
    """Return the eight points of order dividing 8.

    The group is cyclic of order 8 times the prime ``L``, so ``[L] Q`` has order
    dividing 8 for every point ``Q``; one of order 8 yields all eight as its
    multiples.

    Returns:
        The eight small-order points.
    """
    points: set[tuple[int, int]] = set()
    y = 2
    while len(points) < 8:
        x = curve_x(y)
        if x is not None:
            torsion = scalar_mult(L, (x, y))
            points |= {scalar_mult(k, torsion) for k in range(8)}
        y += 1
    return points


def small_order_encodings() -> frozenset[bytes]:
    """Return every encoding of a small-order point, with the sign bit cleared.

    Covers each point's canonical ``y`` and, where ``y + p`` still fits the
    255-bit field, its non-canonical twin, in the little-endian encoding of
    RFC 8032 section 5.1.2 with the top bit (the sign of ``x``) cleared.

    Returns:
        The 32-byte encodings.
    """
    encodings = set()
    for _x, y in small_order_points():
        for value in (y, y + P):
            if value < 2**255:
                encodings.add(value.to_bytes(32, "little"))
    return frozenset(encodings)
