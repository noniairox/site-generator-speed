[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/noniairox/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/noniairox/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator-speed

A faster drop-in for makefun-site 1.0.0. `solve.js` is an own implementation of
makefun-site's build (front matter, template dialect, Markdown subset, slug rule
and build report), written to return byte-identical output while doing the work
faster: HTML escaping fused into the inline scan, index-range inline rendering,
a single-pass Markdown renderer, cached slugs and dates, and one card per source.

`main.ts` is the harness driver: it reads every case from `/input/cases.json`,
answers each with `run`, and writes `/output/answers.json`.

Built for the [make.fun bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122).
