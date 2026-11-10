calcy is a calculator that understands **units**, **uncertainty**, and **rates over
time**. Type plain maths and get an answer—and when you're not sure of a number, you
can type a range and calcy carries that "give or take" all the way through to the
result.

### Find a path

- [See which inputs track an uncertain result](#interpreting-sensitivity) — start with **Uncertainty drivers**.
- [Compare named cases](#compare-a-few-scenarios) — open **Scenario comparison**.
- [Filter estimates using evidence](#conditioning-on-evidence) — open **Condition on evidence**.
- [Understand sampling and reproducibility](#sampling-not-enumeration).


### Start typing

Each line is its own little calculation:

```
$20 + $5             # → $25.00
10% of 250           # → 25
2 GB / 500 MB        # → 4
```

Units are part of the maths, so calcy keeps you honest: mix things that don't
belong together—like `10 m + 5 s`—and it tells you, instead of quietly
handing back a wrong answer.

### "Convert" vs "range": `in` and `to`

Two small words, kept separate so calcy always knows which you mean:

- `in` **converts** units—`5 km in mi` → 3.11 mi, and it tidies a mixed-unit
  sum into one unit—`5 km + 3 mi in km` → 9.83 km
- `to` builds a **range**—`5 to 10 kg` means "somewhere between 5 and 10"

If you write `5 km to mi` hoping to convert, calcy spots it and points you to `in`.

### Give things names

```
goal = 50k $         # k means thousand (M means million)
monthly = goal / 12  # reuse names you defined earlier
```

Anything after `#` is just a note to yourself, and a name you defined above can be
reused on any line below it.

### When you're not sure of a number

Real life is rarely one exact figure. Type a range and calcy works out the likely
result for you:

```
visitors = 800 to 1200       # people you expect in a day
revenue = visitors * $4.50   # if each spends $4.50
```

calcy shows a **median** followed by a low-to-high range in brackets—the middle
value of the simulated results and the span it will probably stay within. It is
not a claim that the median is the most common or most likely value. The
uncertainty in `visitors` flows straight through into `revenue`.

A few other friendly ways to say "roughly":

- `3 ± 1 day`—give or take a day
- `about 5 kg` or `~5 kg`—roughly, give or take ~10%
- `normal(100, 15)`—a bell curve around 100, give or take 15

Pick whichever matches how you'd say it out loud—no statistics background needed.

<h3 id="interpreting-sensitivity">Interpreting sensitivity</h3>

Select an uncertain result in the Sheet grid to see which named sampled variables
track its draws most strongly. The list is sorted by squared Pearson correlation
(r²), with near-zero and unmeasurable entries omitted. It examines all named
sampled variables of matching length—not just direct inputs—so derived or
otherwise unrelated variables can appear. Shared sample arrays and variables
without samples are skipped.

Treat this as a rough linear association ranking, not additive contribution
percentages or evidence of cause. Correlated inputs can overlap, and nonlinear
relationships may not rank strongly. **Uncertainty drivers** is a ready-made
example; reroll to see the ranking vary with the draws.

<h3 id="conditioning-on-evidence">Conditioning on evidence</h3>

`chance(duration < 8 day)` reports the fraction of sampled durations below the
threshold. `duration given duration < 8 day` filters to those matching draws and
resamples them with replacement to make a conditioned distribution. Compare
`mean(duration)` with the filtered mean to see the effect.

This is a conditional view of one value, not a new prior or an update to the
original variables or full joint model. If no draws satisfy the condition,
there is no conditioned result. **Condition on evidence** demonstrates the
pattern.

<h3 id="sampling-not-enumeration">Sampling, not enumeration</h3>

Many uncertain calculations use a finite Monte Carlo sample; they do not
enumerate every possible outcome. Some supported operations have analytical
exact paths. Rerolling can change sampled estimates and sensitivity rankings,
especially with few samples. A fixed seed reproduces the same sheet source with
the same engine and settings. For reproducibility, keep the source, seed, and
settings unchanged, including sampling **N**. Changing source, sample count, or
other settings can change results.

**Scenario comparison** is different: its named cases are explicit scalar
alternatives carried along a shared axis, not random draws or probability-weighted
odds. Use `chance(...)` with an uncertain distribution when asking about odds.

### Ask questions

With the `visitors` and `revenue` from above, you can ask plain-language questions:

```
chance(revenue > $5000)     # how likely is a $5,000 day?
mean(revenue)               # the average
median(visitors)            # the middle value
```

<h3 id="compare-a-few-scenarios">Compare a few scenarios</h3>

Sometimes you don't have one number—you have a few named cases you want to see
side by side. `scenario(...)` holds them all at once (the cases are called
`case` unless you name the axis yourself), and any maths you do carries every
case through:

```
price = scenario(low: 8, base: 10, high: 14) $   # → case: low=$8.00, base=$10.00, high=$14.00
```

When several numbers vary across the same cases, line them up in a `scenario:`
table—one row per variable, one column per case. The `#` row names the cases,
and everything downstream still carries them all:

```
scenario case:
  #         low    base   high
  price  = 8      10     14     $
  demand = 1200   1000   700
revenue = price * demand   # → case: low=$9,600.00, base=$10,000.00, high=$9,800.00
```

Pull out one case with `pick`, or collapse them all with a reducer and `over`:

```
mid = pick(revenue, case = "base")   # → $10,000.00
best = max(revenue over case)   # → $10,000.00
```

### When two things move together

If two uncertain numbers tend to rise and fall together—or push against each
other—`correlate` links them, so the connection shows up in whatever you compute
next:

```
sales = normal(1000, 200)
fee = correlate(sales, normal(20, 5), -0.6)   # busier days tend to mean a lower fee
takings = sales * fee
```

The last number (−1 to 1) is how tightly they move: `0.6` together, `-0.6`
apart, `0` not at all. Each keeps its own shape—only the pairing between them
changes.

When more than two things move together, group them in a `correlate:` block:
define each one on its own indented line, then name the pairs that are linked.
Anything you don't mention stays independent.

```
correlate:
  traffic    = pert(10k, 50k, 100k) req
  conversion = normal(0.02, 0.005)
  spend      = 100 to 300 $

  cor(traffic, conversion) = 0.5
  cor(traffic, spend)      = -0.3
revenue = traffic * conversion * spend
```

Every variable still keeps its own shape; only the pairing between them changes.
Because the block defines them together, a linked variable never slips into the
rest of your sheet in an uncoupled form.

### Rates over time

A value measured *per unit of time*—`12k req/s`, `$200/day`, `30 MB/s`—is a **rate**.
calcy recognises it and shows the same speed at every scale (per second, minute,
hour … year), so you never have to convert in your head. Use `in` to pick a time base:

```
12k req/s              # → 12K req/s
12k req/s in req/day   # → 1.04B req/day
```

Multiply a rate by a length of time and the "per time" cancels out, leaving a plain
total—calcy calls this **accumulating**, and it works even when the rate is uncertain:

```
12k req/s * 30 day            # → 31.1B req
(2 to 5) MB/s * 1 day in TB   # uncertain rate, totalled over a day
```

Every rate also gets a **Rate Card** beside your sheet, with an **Accumulate over**
control (and an optional growth rate), so you can roll a rate up over any window
without typing the multiplication yourself.

### Money

Currency symbols work however you like to write them, and each currency stays
separate so they're never added together by accident:

```
$5 + 3 $     # → $8.00
₹2500000     # → ₹2,500,000.00
```

You can even set your own exchange rate and convert across currencies. `bridge`
names a rate; `via` tells calcy which one to use:

```
bridge fx = 83 ₹/$
1000 $ in INR via fx     # → ₹83,000.00
```

### Exact or estimated—you don't choose

When a calculation has one exact answer, calcy gives you that. When you've
described something uncertain, it estimates the likely outcome instead. Both are
real calculations—the estimate is a principled simulation, not a hand-wave—and
you never have to pick which one you want.

### Back up & move your data

Everything lives on your own device, so it's worth keeping a copy. Open
**Settings** (the ⚙ button) and look under **Export & Import**:

- **Export backup** saves all your sheets, custom units, and settings as a single
  `.json` file. **Import backup** reads one back in—it *merges*, so anything
  already here is kept rather than overwritten. This is the easy way to move to
  another browser or device.
- **Export / Import database** does the same with the raw `.sqlite` file calcy
  keeps behind the scenes—an exact, whole-database copy. Importing one *replaces*
  everything you have.

Further down, **Danger zone** can clear all your sheets or reset your settings,
and **🐉 Here be dragons** can wipe everything on the device for a fresh start.
Each asks first, and none of them can be undone.

Per-sheet exports—plain text, Markdown, or CSV of the sheet you're looking at—live
in the **Copy** menu up in the toolbar.

### Finding your way around

- **Examples**—open a ready-made sheet to learn from
- **?**—a cheat sheet you can click to insert (`⌘/`)
- `⌘K` your sheets · `⌘↵` reshuffle the estimates · `Esc` close

On Windows and Linux, use `Ctrl` wherever these show `⌘`. Everything runs on your
own device—no account, no internet needed. Your sheets are saved right here, and
**Share** packs one into a link you can send to anyone.
