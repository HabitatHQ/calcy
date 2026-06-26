// Starter templates — pre-filled, editable sheets a user can load instead of
// facing a blank page. Each is short, valid, and showcases one of calcy's
// domains; tests/templates.test.ts evaluates every one so a grammar change can
// never ship a broken starter.

export interface Template {
	title: string;
	blurb: string;
	body: string;
}

export const TEMPLATES: Template[] = [
	{
		title: 'Start here',
		blurb: 'learn calcy through one 10K run',
		body: `# 👋 Start here—learn calcy through a single 10K run.
# Edit anything; each line's answer lands on the right.

# Units are part of the math. Name a value once, reuse it below:
distance = 10 km

# Rates carry a "per" unit. You know it's an easy pace but not the
# exact number, so type a range with "to"—calcy carries that
# uncertainty through every line that depends on it:
pace = (5 to 6) min/km

# Multiply distance by pace to get time; "in" converts the units:
time = distance * pace in min

# Reuse names freely—distance and time give an average speed:
speed = distance / time in km/h

# Another rate, over time: burning 600 kcal for each hour you run:
burn = 600 kcal/h * time in kcal

# Ask a question about an uncertain result and read the odds:
chance(time < 55 min)`
	},
	{
		title: 'Project estimate',
		blurb: 'roll up tasks, read the deadline odds',
		body: `# Project estimate — tasks in plain English
design  = two days to four days
backend = between 5 and 12 days
qa      = 3 ± 1 day
total   = sum(above) in day
chance(total < 20 day)        # odds of hitting the deadline`
	},
	{
		title: 'Traffic forecast',
		blurb: 'an uncertain rate, projected forward',
		body: `# Traffic forecast — requests per second
peak     = (800 to 1200) req/s
per_day  = peak * 1 day
# 8% month-over-month growth, a year out:
year_out = peak * 1.08^12`
	},
	{
		title: 'Capacity & headroom',
		blurb: 'will it fit, and how many nodes?',
		body: `# Capacity check
peak     = (800 to 1200) req/s
capacity = 1000 req/s
chance(peak > capacity)       # odds we're over capacity
per_node = 250 req/s
nodes    = ceil(p(peak, 0.95) / per_node)   # cover the 95th pct`
	},
	{
		title: 'Cloud cost',
		blurb: 'usage × an uncertain unit price',
		body: `# Monthly cloud cost
instances = 10
price     = (0.04 to 0.06) $/hour     # spot-price uncertainty
hours     = 730 hour                  # ~1 month
instances * price * hours in $`
	},
	{
		title: 'Fermi estimate',
		blurb: 'order-of-magnitude from a few guesses',
		body: `# Fermi estimate — piano tuners in a city
people         = 1_000_000
pianos         = people * (0.02 to 0.1)   # fraction with a piano
tunings        = pianos * 1               # per piano per year
jobs_per_tuner = 4 * 250                  # one tuner's yearly jobs
tuners         = tunings / jobs_per_tuner`
	},
	{
		title: 'Calibrated estimate',
		blurb: 'pin your own percentiles, then condition and scope',
		body: `# Calibrated estimate — your own percentiles
effort     = p10: 3 day, p90: 12 day      # pin the 10th & 90th percentiles
chance(4 day < effort < 9 day)            # odds it lands in the sweet spot
optimistic = effort given effort < 8 day  # condition on a good outcome
billable   = effort * rate where rate = 500 $/day   # one-off local rate`
	},
	{
		title: 'Events & bursts',
		blurb: 'counts and waits between events',
		body: `# Events in a burst window
arrivals = poisson(1000) req      # requests in the window
gap      = exponential(200 ms)    # time between events
chance(arrivals > 1100 req)       # odds of a heavier burst`
	},
	{
		title: 'Reactor sizing',
		blurb: 'first-order kinetics → PFR & CSTR volume, with uncertainty',
		body: `# Reactor sizing — first-order liquid reaction A → B
# Arrhenius rate, then the plug-flow design equation V = v0 · τ.
unit R = 8.314 J/(mol K)              # gas constant
k0   = 1e10 / s                       # pre-exponential factor (1st order)
Ea   = (78 to 82) kJ/mol              # activation energy (uncertain)
T    = 77 °C                          # operating temperature
k    = k0 * exp(-Ea / (R * T))        # Arrhenius rate constant k(T)
X    = 0.9                            # target conversion
v0   = 50 L/min                       # volumetric feed
tau  = -ln(1 - X) / k                 # PFR space-time: τ = −ln(1−X)/k
V_pfr  = v0 * tau in L                # PFR volume
V_cstr = v0 * X / (k * (1 - X)) in L  # a CSTR needs ~4× more for the same X
chance(V_pfr < 250 L)                 # odds a 250 L PFR is big enough`
	},
	{
		title: 'Carbon footprint',
		blurb: 'workload energy × grid carbon, defer to cut it',
		body: `# Carbon-aware workload
workload_kwh = (800 to 1200) kWh
grid_carbon  = (200 to 600) gCO2/kWh   # wide range — coal vs. wind hour
naive_kg     = workload_kwh * mean(grid_carbon) in kgCO2
# shifting 30% of the load to low-carbon windows:
shifted_kg   = workload_kwh * mean(grid_carbon) * 0.7 in kgCO2
savings_kg   = naive_kg - shifted_kg
chance(savings_kg > 100 kgCO2)         # did deferring pay off?`
	}
];
