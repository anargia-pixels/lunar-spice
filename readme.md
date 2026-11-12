# Lunar Spice

An interactive circuit simulator for Linux, macOS and the web, in the spirit of
[Falstad's](https://www.falstad.com/circuit/). Draw a circuit and watch current flow, then
run the analyses you would reach for in Multisim:

- **Interactive**: real-time simulation with voltage colors, moving current dots,
  clickable switches and live scopes.
- **DC operating point**: every net voltage and every part's voltage, current and power.
- **AC sweep**: gain and phase (Bode plots) from small-signal analysis around the
  operating point.
- **Transient**: voltages and currents over time, from rest or from the operating point.

## Parts

A small set of components, each configurable from its datasheet: pick a real part (1N4148,
1N4007, 2N3904, BC547B, 2N7000, IRF540N, 2N3819, LM741, TL072, 7805, 7912, LM317, LM337,
NE555, …), paste a vendor SPICE `.model` card, or type the values yourself.

Resistor · capacitor (ESR) · inductor (DCR) · DC and AC sources (internal resistance) ·
rail · current source · switch, push switch (normally open or closed) and changeover
switch · diode and Zener · LED · NPN/PNP · N/P-channel MOSFET · N/P-channel JFET · op-amp
(gain, GBW, slew rate, Rin, Rout, offset, swing) · Schmitt trigger, buffer or inverter
(thresholds, output levels, output resistance, slew rate) · fixed regulator (7805-style) ·
adjustable regulator (LM317-style) · 555 timer · electret microphone (live from your
microphone, or a test tone) · speaker (plays through your speakers) · voltage probe · net
label · ground.

Parts have a fixed size, as in Multisim: a click places one, and `[` `]`, H and V turn or
mirror it before you click. Only wires stretch. The interactive simulation runs in real
time by default; the speed slider steps from 1/1000× to 1000×, and microphones and
speakers work at 1×.

Wires route as in Multisim and EasyEDA: click to start one, click again for each corner,
and it ends on the pin or wire you click, on a double-click, or with a right-click or
Escape. With the select tool, a click on a pin starts a wire from it. A wire or pin that
lands on the middle of another wire joins it; wires that only cross stay apart. Ends that
join nothing are ringed and counted under the canvas. Moving a part keeps it connected:
its wires stretch along, with a right-angle bend where they would run at a slant, and a
part that touched it directly gets a new wire.

Each part's name and value can be dragged to a clearer spot, and its name changed in its
properties (`R1` can become `Rload`). Schematic text uses Poppins or JetBrains Mono, from
View › Schematic font.

## Files

The desktop app saves circuits in `~/Documents/lunar-spice` as `.circuit` files in
Falstad's text format; the web app keeps them in the browser's storage (IndexedDB). File ›
Import… opens a `.circuit` file or a Falstad export (`.txt`) as a draft; components Lunar
Spice lacks are left out with a warning. File › Export… writes the open circuit to a file
(a download on the web), so circuits move between browsers and the desktop app.

## Keyboard

Moving, zooming, rotating and flipping follow Inkscape. Press `?` in the app for the full
list.

## Development

```sh
bun install
bun run dev:desktop  # launch the desktop app
bun run dev:web      # serve the web app at http://localhost:3000
bun run test         # simulator tests
bun run lint && bun run check-types
```

See [AGENTS.md](AGENTS.md) for the layout and conventions.

## License

Lunar Spice is licensed under the [GNU Affero General Public License v3.0](LICENSE) or
later. You may use, change, and redistribute it for any purpose, including commercial
ones. If you run a modified version as a network service, you must offer its complete
source code to the people who use it. Lunar Spice comes with no warranty of any kind.
