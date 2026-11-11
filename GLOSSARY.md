<!-- prettier-ignore-start -->
# Lunar Spice glossary

**Lunar Spice**:
The product: an Electron circuit simulator in the spirit of Falstad's.

**Circuit**:
One schematic, saved as a `.circuit` file in Falstad's text format.
_Avoid_: project, design, netlist (as the file)

**Draft**:
An open circuit that has never been saved to the circuits folder.

**Element**:
A component in code (`CircuitElement`). UI copy says _component_ or _part_.

**Part**:
A real device an element can represent, picked from presets or a SPICE model
(1N4148, 2N3904, LM741).

**Post**:
A point where an element connects to others. Posts at the same point join.

**Net**:
A set of connected posts; one node in the solve. Named by a net label, else `n` and its
number; ground is `0`.

**Interactive simulation**:
The real-time transient that animates the canvas, Falstad-style.
_Avoid_: live mode, run mode

**Analysis**:
A one-shot run in the worker: DC operating point, AC sweep or transient.

**Scope**:
A live plot of one element's voltage and current during the interactive simulation.

**Trace**:
One plotted quantity in an analysis result, such as `V(out)` or `I(R1)`.
<!-- prettier-ignore-end -->
