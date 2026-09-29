# Pairwise study output

Produced by `npm run study:pairwise` (`research/pairwise-study.ts`). Seeded: the same command prints the same numbers.

```text
Layout from fixtures.json: 121 reviews, 40 projects, 29 judges; 300 simulated events per scenario

Scenario: judges differ in bias only (SD 0.5)
| Method | Rank correlation with truth | True top 5 found |
|---|---|---|
| raw mean | 0.840 | 64% |
| offsets, lambda 2 (the ranking) | 0.867 | 67% |
| within-judge Bradley–Terry (the second opinion) | 0.810 | 58% |
| mean of the two ranks | 0.864 | 66% |

Scenario: judges differ in bias and in spread (x0.5 to x2)
| Method | Rank correlation with truth | True top 5 found |
|---|---|---|
| raw mean | 0.835 | 64% |
| offsets, lambda 2 (the ranking) | 0.857 | 66% |
| within-judge Bradley–Terry (the second opinion) | 0.811 | 60% |
| mean of the two ranks | 0.861 | 66% |

Scenario: strong bias (SD 0.8)
| Method | Rank correlation with truth | True top 5 found |
|---|---|---|
| raw mean | 0.763 | 56% |
| offsets, lambda 2 (the ranking) | 0.819 | 61% |
| within-judge Bradley–Terry (the second opinion) | 0.809 | 57% |
| mean of the two ranks | 0.846 | 64% |

Scenario: no bias at all (the null case)
| Method | Rank correlation with truth | True top 5 found |
|---|---|---|
| raw mean | 0.904 | 72% |
| offsets, lambda 2 (the ranking) | 0.900 | 71% |
| within-judge Bradley–Terry (the second opinion) | 0.817 | 61% |
| mean of the two ranks | 0.877 | 69% |

```
