// Cheat-sheet of the expression language (US-1), shared between the HelpPanel
// (click-to-insert UI) and the doctest suite (tests/help-doctests.test.ts), so
// every example shown to users is proven to evaluate without error.
//
// Items within a group are treated as one running sheet: later lines may build
// on earlier ones (e.g. `total = sum(above)` follows the lines it rolls up), so
// the doctest concatenates a group's snippets in order.

export interface CheatItem {
  code: string;
  note: string;
}
export interface CheatGroup {
  title: string;
  items: CheatItem[];
}

export const CHEAT_SHEET: CheatGroup[] = [
  {
    title: 'Units & conversion',
    items: [
      { code: '5 km + 3 mi', note: 'unit-aware arithmetic' },
      { code: '60 km / 1 h', note: 'compose dimensions → speed' },
      { code: '5 km in mi', note: 'convert with in (to builds a range)' },
      { code: '1.2 GB in MB', note: 'data units' },
      { code: '9.8 m/s²', note: 'superscripts are exponents' }
    ]
  },
  {
    title: 'Variables & comments',
    items: [
      { code: 'rate = 12_000 req/s', note: 'assign a name' },
      { code: 'rate * 30 day', note: 'reuse it later' },
      { code: 'budget = 1.2M $', note: '`k` / `M` magnitude suffixes' },
      { code: '# back-of-envelope', note: 'comment with #' }
    ]
  },
  {
    title: 'Rates & accumulation',
    items: [
      { code: '12k req/s in req/day', note: 'time-base conversion' },
      { code: '(2 to 5) MB/s * 1 day in TB', note: 'accumulate a rate' }
    ]
  },
  {
    title: 'Uncertainty',
    items: [
      { code: '800 to 1200', note: '90% confidence interval' },
      { code: 'p10: 5, p90: 50', note: 'pin your own percentiles' },
      { code: 'normal(100, 15)', note: 'mean, std-dev' },
      { code: 'lognormal(10, 100)', note: 'positive, skewed' },
      { code: 'x = 1 to 10\nx - x', note: 'reuse → correlated (= 0)' }
    ]
  },
  {
    title: 'Plain English',
    items: [
      { code: 'two days to four days', note: 'spell out numbers' },
      { code: 'between 2 and 4 days', note: 'natural range' },
      { code: '3 ± 1 day', note: 'give or take (also +-)' },
      { code: 'about 5 days', note: 'rough estimate (≈ ±10%)' }
    ]
  },
  {
    title: 'Estimation',
    items: [
      { code: 'pert(2, 3, 8) day', note: 'three-point estimate' },
      { code: 'a = (2 to 4) day\nb = (5 to 12) day\nsum(above)', note: 'roll up tasks' },
      { code: 'total = sum(above)\nchance(total < 25 day)', note: 'odds of hitting a deadline' }
    ]
  },
  {
    title: 'Distributions & scenarios',
    items: [
      { code: 'poisson(1000) req', note: 'count of events in a window' },
      { code: 'exponential(5 day)', note: 'time between events' },
      { code: 'triangular(2, 3, 8) day', note: 'three-point (min/likely/max)' },
      { code: 'discrete(0.2, 100, 0.8, 200)', note: 'weighted scenarios' },
      { code: 'clamp(1 to 9, 2, 7)', note: 'keep within bounds' }
    ]
  },
  {
    title: 'Readable calls',
    items: [
      { code: 'pert(low=2, likely=3, high=8) day', note: 'named arguments' },
      { code: 'mean of (1 to 9)', note: 'one-arg calls read as “f of x”' },
      { code: '20% of 200', note: 'percent of a value (= 40)' },
      { code: '(800 to 1200) |> p(0.95)', note: 'pipe into a function' },
      { code: 'discrete(60%: 12, 40%: 20)', note: 'weight: value pairs' },
      { code: 'cagr(100, 150, 5)', note: 'compound growth rate / period' }
    ]
  },
  {
    title: 'Custom units',
    items: [
      { code: 'unit sprint = 2 week', note: 'define your own' },
      { code: 'unit req = 1', note: 'a dimensionless count' }
    ]
  },
  {
    title: 'Currencies & FX',
    items: [
      { code: '$5 + 3 $', note: 'symbol prefix or postfix' },
      { code: 'currency BTC, bitcoin', note: 'mint your own currency' },
      { code: 'bridge fx = 83 ₹/$\n1000 $ in INR via fx', note: 'convert with an FX rate' }
    ]
  },
  {
    title: 'Constants & trig',
    items: [
      { code: '2 * pi', note: 'pi, tau, e are built in' },
      { code: 'sin(pi / 2)', note: 'radians; sin/cos/tan + inverses' },
      { code: 'sin(90 deg)', note: 'deg is a dimensionless angle' }
    ]
  },
  {
    title: 'Decibels (logarithmic)',
    items: [
      { code: '30 dBm in W', note: 'power level → 1 W' },
      { code: '0.1 W in dBm', note: 'watts → 20 dBm' },
      { code: '3 dB', note: 'a power ratio → ×1.995' }
    ]
  },
  {
    title: 'Bracket math',
    items: [
      {
        code: 'income = 50000\ntax = bracket(income, 11600: 10%, 47150: 12%, Infinity: 37%, total=yes)',
        note: 'progressive tax: cumulative owed'
      },
      {
        code: 'bracket(50000, 11600: 10%, 47150: 12%, Infinity: 22%)',
        note: 'marginal rate at x'
      },
      {
        code: 'cost = bracket(20000 req, 10000 req: 0 $/req, Infinity req: 0.001 $/req, total=yes) in $',
        note: 'tiered cloud pricing'
      }
    ]
  },
  {
    title: 'Bayes update',
    items: [
      { code: 'beta(2, 8) seen 3 of 10', note: 'postfix update (= update(prior, k, n))' },
      { code: 'prior = beta(2, 8)\nprior seen 3 of 10', note: 'update a named prior' },
      { code: 'update(beta(2, 8), k=3, n=10)', note: 'named-arg form' },
      { code: 'ci(2, 10, 0.95)', note: 'explicit CI at a chosen level' }
    ]
  },
  {
    title: 'Conditioning & scenarios',
    items: [
      { code: 'demand = normal(1000, 200)', note: 'an uncertain quantity' },
      { code: 'demand given demand > 0', note: 'condition: keep only valid draws' },
      { code: 'chance(800 < demand < 1200)', note: 'chained comparison → a band' },
      { code: 'cost = rate * n where rate = 0.5, n = 100', note: 'one-off locals with where' }
    ]
  }
];
