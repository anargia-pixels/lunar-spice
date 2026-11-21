# Lunar Spice

An interactive circuit simulator for Linux, macOS and the web, in the spirit of
[Falstad's](https://www.falstad.com/circuit/). Draw a circuit and watch current flow, then
run the analyses you would reach for in Multisim:

- **Interactive**: real-time simulation with voltage colors, moving current dots,
  clickable switches, live scopes and a four-channel oscilloscope.
- **DC operating point**: every net voltage and every part's voltage, current and power.
- **AC sweep**: gain and phase (Bode plots) from small-signal analysis around the
  operating point.
- **Transient**: voltages and currents over time, from rest or from the operating point.

## Parts

A small set of components, each configurable from its datasheet: pick a real part (1N4148,
1N4007, 2N3904, BC547B, 2N7000, IRF540N, 2N3819, LM741, TL072, LM393, 7805, 7912, LM317,
LM337, NE555, PC817, 4N35, VTL5C3, …), paste a vendor SPICE `.model` card, or type the
values yourself.

Resistor · capacitor (ESR) · inductor (DCR) · DC and AC sources (internal resistance) ·
rail · current source · switch, push switch (normally open or closed) and changeover
switch · diode and Zener · LED · optocoupler (LED and phototransistor: CTR, VCE(sat), rise
time) · vactrol (LED and photoresistor: the datasheet's resistance at 1, 10 and 40 mA,
dark resistance, fast turn-on and slow turn-off) · NPN/PNP · N/P-channel MOSFET ·
N/P-channel JFET · op-amp (gain, GBW, slew rate, Rin, Rout, offset, swing; VCC and VEE
pins, with its output swinging to each supply less the datasheet's drop) · Schmitt
trigger, buffer or inverter (thresholds, output levels, output resistance, slew rate) ·
fixed regulator (7805-style) · adjustable regulator (LM317-style) · 555 timer · electret
microphone (live from your microphone, a test tone, or a clip you record or open, played
on repeat) · speaker (plays through your speakers) · voltmeter · voltage probe (to ground,
with V(p-p), V(rms), V(dc) and frequency, as in Multisim) · oscilloscope (four channels
against COM) · net label · ground.

Parts have a fixed size, as in Multisim: a click places one, and `[` `]`, H and V turn or
mirror it before you click. Only wires stretch. A voltage probe rests on any wire or post
and reads that net without changing the wiring, so it can be moved freely; its properties
pick which readings it shows and their text size. An oscilloscope (Shift+O) is wired in
like any part; its front panel in the results panel sets volts and time per division, each
channel's DC, AC or GND coupling, positions by slider or typed value, the trigger (Auto,
Normal or Single), Auto set, measurements and time or voltage cursors, shows the sample
rate and record length, and saves with the circuit. The interactive simulation runs in
real time by default; the speed slider steps from 1/1000× to 1000×, and microphones and
speakers work at 1×. The time step follows the speed unless you turn off Automatic time
step and set your own; the circuit file keeps it.

Wires route as in Multisim and EasyEDA: click to start one, click again for each corner,
and it ends on the pin or wire you click, on a double-click, or with a right-click or
Escape. With the select tool, a click on a pin starts a wire from it. A wire or pin that
lands on the middle of another wire joins it; wires that only cross stay apart. A wire
drawn over another, or wires that meet in a straight line with nothing else at the joint,
become one wire. Ends that join nothing are ringed and counted under the canvas; click the
count to bring them into view and flag them. Moving a part keeps it connected: its wires
stretch along, with a right-angle bend where they would run at a slant, and a part that
touched it directly gets a new wire.

Each part's name and value can be dragged to a clearer spot, and its name changed in its
properties (`R1` can become `Rload`). Schematic text uses Poppins or JetBrains Mono, from
View › Schematic font. The canvas grid shows dots or lines, chosen under Settings ›
Appearances › Grid style. Settings › Appearances › Show net names tags each net with the
name results use, such as `n12`; drag a tag to move it. Right-click a selection and choose
Copy as PNG (`Alt+Shift+C`) to paste a picture of it into a document or chat, as in
Excalidraw.

Ctrl+G draws a titled outline around the selection, like an Excalidraw frame: drag it by
its border or title and whatever lies inside moves, copies and deletes with it. Drag its
corners to resize it, double-click it to rename it, and Ctrl+Shift+G removes the outline
and keeps the parts. Falstad's boxes open as groups.

## Agents

The app offers tools to AI agents through
[WebMCP](https://github.com/webmachinelearning/webmcp), so an agent in the browser can
build and test circuits in the open editor: list the parts, read the circuit with the pins
on every net, place parts, wire or label pins together, change values, delete parts, write
the circuit file, run an analysis and run the interactive simulation. Each edit is one
undo step, and analyses show in the results panel. WebMCP is behind
`chrome://flags/#enable-webmcp-testing` in Chrome; `agent-browser` turns it on by itself
(`agent-browser webmcp list`). Scripts that drive the page without WebMCP can call the
same tools as `window.lunarSpice.callTool(name, input)`.

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
