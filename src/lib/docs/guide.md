calcy is a calculator that understands **units**, **uncertainty**, and **rates over
time**. Type plain maths and get an answer—and when you're not sure of a number, you
can type a range and calcy carries that "give or take" all the way through to the
result.

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

calcy shows a **middle estimate** followed by a low-to-high range in brackets—the value the answer is most likely near, then the span it will probably stay
within. The uncertainty in `visitors` flows straight through into `revenue`.

A few other friendly ways to say "roughly":

- `3 ± 1 day`—give or take a day
- `about 5 kg` or `~5 kg`—roughly, give or take ~10%
- `normal(100, 15)`—a bell curve around 100, give or take 15

Pick whichever matches how you'd say it out loud—no statistics background needed.

### Ask questions

With the `visitors` and `revenue` from above, you can ask plain-language questions:

```
chance(revenue > $5000)     # how likely is a $5,000 day?
mean(revenue)               # the average
median(visitors)            # the middle value
```

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
real calculations—neither is a guess, and you never have to pick which one you
want.

### Finding your way around

- **Examples**—open a ready-made sheet to learn from
- **?**—a cheat sheet you can click to insert (`⌘/`)
- `⌘K` your sheets · `⌘↵` reshuffle the estimates · `Esc` close

On Windows and Linux, use `Ctrl` wherever these show `⌘`. Everything runs on your
own device—no account, no internet needed. Your sheets are saved right here, and
**Share** packs one into a link you can send to anyone.
