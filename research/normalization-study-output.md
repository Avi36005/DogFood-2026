# Output of `npm run study` (seeded; rerun to reproduce)

```text
Layout from fixtures.json: 121 reviews, 40 projects, 29 judges
Reviews per judge: min 1, median 3, max 11; 300 simulated events per scenario

Scenario: judges differ in bias only (SD 0.5)
| Method | Rank correlation with truth | True top 5 found | Projects ranked |
|---|---|---|---|
| A  raw mean | 0.840 | 64% | 40.0 |
| B  z-score, judges with >= 3 reviews | 0.803 | 59% | 40.0 |
| C  z-score, judges with >= 2 reviews | 0.808 | 60% | 40.0 |
| D  offsets, no shrinkage (lambda 0) | 0.700 | 52% | 40.0 |
| E  offsets, lambda 2 (Forgeboard) | 0.867 | 67% | 40.0 |
| F  offsets, lambda 5 | 0.860 | 67% | 40.0 |

Scenario: judges differ in bias and in spread (x0.5 to x2)
| Method | Rank correlation with truth | True top 5 found | Projects ranked |
|---|---|---|---|
| A  raw mean | 0.835 | 64% | 40.0 |
| B  z-score, judges with >= 3 reviews | 0.802 | 59% | 40.0 |
| C  z-score, judges with >= 2 reviews | 0.807 | 60% | 40.0 |
| D  offsets, no shrinkage (lambda 0) | 0.705 | 51% | 40.0 |
| E  offsets, lambda 2 (Forgeboard) | 0.857 | 66% | 40.0 |
| F  offsets, lambda 5 | 0.852 | 66% | 40.0 |

Scenario: strong bias (SD 0.8)
| Method | Rank correlation with truth | True top 5 found | Projects ranked |
|---|---|---|---|
| A  raw mean | 0.763 | 56% | 40.0 |
| B  z-score, judges with >= 3 reviews | 0.801 | 57% | 40.0 |
| C  z-score, judges with >= 2 reviews | 0.805 | 59% | 40.0 |
| D  offsets, no shrinkage (lambda 0) | 0.701 | 52% | 40.0 |
| E  offsets, lambda 2 (Forgeboard) | 0.819 | 61% | 40.0 |
| F  offsets, lambda 5 | 0.801 | 59% | 40.0 |

Scenario: no bias at all (the null case)
| Method | Rank correlation with truth | True top 5 found | Projects ranked |
|---|---|---|---|
| A  raw mean | 0.904 | 72% | 40.0 |
| B  z-score, judges with >= 3 reviews | 0.807 | 59% | 40.0 |
| C  z-score, judges with >= 2 reviews | 0.813 | 60% | 40.0 |
| D  offsets, no shrinkage (lambda 0) | 0.715 | 55% | 40.0 |
| E  offsets, lambda 2 (Forgeboard) | 0.900 | 71% | 40.0 |
| F  offsets, lambda 5 | 0.903 | 72% | 40.0 |

Lambda sweep (bias-only scenario): rank correlation with truth
| lambda | 0 | 0.5 | 1 | 2 | 3 | 5 | 10 | 25 |
|---|---|---|---|---|---|---|---|---|
| rho | 0.699 | 0.863 | 0.865 | 0.864 | 0.862 | 0.858 | 0.852 | 0.848 |
```
