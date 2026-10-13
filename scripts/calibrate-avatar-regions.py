"""Calibrate equal planar areas for the avatar compass (stdlib only).

Run after changing avatarStyleTraits; copy the emitted offsets into avatarRegionOffsets.
Pass --measure to measure the saved offsets without recalibrating them.
Uses clipped power cells and Newton steps, then independently measures a finer disk.
This is a design calibration utility, not an application build or test suite.
"""
import math
from pathlib import Path
import re
import sys

source = (Path(__file__).resolve().parents[1] / 'lib/avatarExploration.ts').read_text()
traits = source.split('export const avatarStyleTraits', 1)[1].split('];', 1)[0]
sites = [(name, float(x), -float(energy)) for name, x, energy in
         re.findall(r"\['([^']+)',\s*([.\d-]+),\s*([.\d-]+)\]", traits)]
count = len(sites)


def disk(segments):
    return [(math.cos(i * math.tau / segments), math.sin(i * math.tau / segments))
            for i in range(segments)]


def clip(polygon, nx, ny, limit):
    if not polygon:
        return []
    result = []
    previous = polygon[-1]
    prev_d = previous[0] * nx + previous[1] * ny - limit
    for current in polygon:
        curr_d = current[0] * nx + current[1] * ny - limit
        if (curr_d <= 0) != (prev_d <= 0):
            ratio = prev_d / (prev_d - curr_d)
            result.append((previous[0] + ratio * (current[0] - previous[0]),
                           previous[1] + ratio * (current[1] - previous[1])))
        if curr_d <= 0:
            result.append(current)
        previous, prev_d = current, curr_d
    return result


def area(polygon):
    return abs(sum(a[0] * b[1] - a[1] * b[0]
                   for a, b in zip(polygon, polygon[1:] + polygon[:1]))) / 2


def cells(weights, boundary):
    result = []
    for i, (_, xi, yi) in enumerate(sites):
        polygon = boundary
        for j, (_, xj, yj) in enumerate(sites):
            if i != j:
                polygon = clip(polygon, 2 * (xj - xi), 2 * (yj - yi),
                               xj*xj + yj*yj - xi*xi - yi*yi + weights[i] - weights[j])
        result.append(polygon)
    return result


def solve(matrix, rhs):
    augmented = [row[:] + [value] for row, value in zip(matrix, rhs)]
    n = len(rhs)
    for col in range(n):
        pivot = max(range(col, n), key=lambda row: abs(augmented[row][col]))
        augmented[col], augmented[pivot] = augmented[pivot], augmented[col]
        scale = augmented[col][col]
        if abs(scale) < 1e-12:
            raise RuntimeError('Degenerate anchors: adjust distinct style positions.')
        augmented[col] = [value / scale for value in augmented[col]]
        for row in range(n):
            if row != col:
                factor = augmented[row][col]
                augmented[row] = [a - factor*b for a, b in zip(augmented[row], augmented[col])]
    return [row[-1] for row in augmented]


boundary = disk(2048)
target = area(boundary) / count
weights = [0.0] * count
measure_only = '--measure' in sys.argv
if measure_only:
    saved = source.split('export const avatarRegionOffsets', 1)[1].split('};', 1)[0]
    offsets = {name: float(value) for name, value in re.findall(r"'([^']+)':\s*([.\d-]+)", saved)}
    weights = [offsets[name] for name, _, _ in sites]
for iteration in range(0 if measure_only else 40):
    areas = [area(cell) for cell in cells(weights, boundary)]
    residual = [target - value for value in areas]
    error = max(abs(value) for value in residual)
    if error < 1e-10:
        break
    epsilon = 1e-5
    columns = []
    for j in range(count - 1):
        shifted = weights[:]
        shifted[j] += epsilon
        columns.append([(area(cell) - value) / epsilon
                        for cell, value in zip(cells(shifted, boundary), areas)])
    jacobian = [[columns[j][i] for j in range(count - 1)] for i in range(count - 1)]
    delta = solve(jacobian, residual[:-1]) + [0.0]
    step = 1.0
    while step > 1e-7:
        candidate = [value + step * change for value, change in zip(weights, delta)]
        candidate_areas = [area(cell) for cell in cells(candidate, boundary)]
        if max(abs(target - value) for value in candidate_areas) < error:
            weights = candidate
            break
        step /= 2
    else:
        raise RuntimeError('Area calibration did not converge.')
else:
    if not measure_only:
        raise RuntimeError('Area calibration exceeded 40 iterations.')

fine_boundary = disk(16384)
total = area(fine_boundary)
print('export const avatarRegionOffsets: Record<string, number> = {')
for (name, _, _), weight in zip(sites, weights):
    print(f"  '{name}': {weight:.12f},")
print('};')
fractions = [area(cell) / total for cell in cells(weights, fine_boundary)]
print(f'// Independent disk measurement: {count} cells, target {100/count:.8f}%, '
      f'range {min(fractions)*100:.8f}%–{max(fractions)*100:.8f}%.')
