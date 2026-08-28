# Photograph credits and licences

Every image here is **public domain** or **CC0**. None requires a licence fee or
permission, none carries a share-alike obligation, and none becomes a problem if
this repository goes public or the site is ever monetised.

Credit is given anyway. It costs nothing and it is the same rule the rest of the
project follows: say where a thing came from.

Licences were checked individually against Wikimedia Commons' machine-readable
metadata rather than trusting a stock site's blanket claim. Stock libraries that
permit free commercial use (Unsplash, Pexels) were considered and passed over:
they carry no indemnification and no model releases, and a government work has
neither problem.

| File | Subject | Source | Licence |
|---|---|---|---|
| `hero-cotton.jpg` | Cotton harvester cutting rows, **Batesville, Texas** | USDA, via Wikimedia Commons | Public domain |
| `crop-water.jpg` | Pivot irrigation drops hanging over cotton, **Batesville, Texas** | USDA NRCS (20200823-NRCS-LSC-0937) | Public domain |
| `crop-standing.jpg` | Corn tassels against summer sky, Warren County, Indiana | Huw Williams, via Wikimedia Commons | Public domain |
| `wx-rain.jpg` | Cotton field under standing water in the rain, **Bloomington, Texas** | USDA NRCS (20210603-NRCS-LSC-0480) | Public domain |
| `wx-sun.jpg` | Sun setting over a cotton harvest, **Batesville, Texas** | USDA, via Wikimedia Commons | Public domain |
| `wx-drought.jpg` | Burnt corn on cracked ground, **Texas**, 20 Aug 2013 | USDA, photo by Bob Nichols | Public domain |
| `wx-harvest.jpg` | Combine unloading corn into a grain cart | Wikideas1, via Wikimedia Commons | CC0 |

## Where they are used

- **Hero** — `hero-cotton.jpg`, full width, behind the masthead.
- **Season tracker cover** — a drawn accumulation curve, then `crop-water.jpg`
  and `crop-standing.jpg`: the chart, the water, and the crop it is grown for.
- **Similar years cover** — `wx-rain.jpg`, `wx-sun.jpg`, `wx-drought.jpg`,
  `wx-harvest.jpg` in a 2×2. Four seasons one field can have, which is what the
  panel's table is ranking past years between. A single photograph could only
  show one of them.

## Why these

**Five of the seven were taken in Texas**, which matters for a Texas tool — a
generic stock field would have been easier to find and would have said nothing
true about the place. Three come from the same farm (Schirmer Farms, Batesville)
as the hero, which is deliberate: one place, told across the site.

The corn-tassels and grain-cart photographs are not from Texas. No comparable
public-domain Texas frame was found for either subject, and both read correctly
regardless of the state line — a standing corn crop and a combine unloading are
the same picture anywhere. Replacing them with Texas equivalents would be an
improvement, not a fix.

**CHECK IMAGES BY LOOKING AT THEM.** Every wrong candidate rejected during this
work had a caption that sounded right: an "irrigated field" that was a close-up
of a person working on a pipe, a "cotton field" that was a drowned crop standing
in storm water, a "lush" contour farm that was mostly harvested stubble. Two
images that had already SHIPPED were also replaced on inspection — an aerial
cotton texture standing in for "a standing crop" (it reads as brown corduroy at
thumbnail size) and a drought photograph of young corn on dry ground that read
as a healthy young crop next to the burnt Texas corn now in its place.

## If you replace one

Keep to public-domain government imagery (USDA ARS, USDA NRCS, NASA, NOAA) or
CC0, and verify the licence yourself on Wikimedia Commons. Fetch at roughly the
displayed size rather than re-encoding locally — Commons' thumbnail renderer
does a better job than a hand-rolled resize, and it is one fewer step to get
wrong.

**Two traps in that fetch.** Commons renders a PNG source as a PNG thumbnail no
matter what extension is requested, so a photograph can silently arrive as a
230 KB PNG named `.jpg`; check the magic bytes and re-encode. And aerial crop
rows are high-frequency detail that JPEG compresses badly, so check the file
size rather than assuming a small pixel count means a small file.
