# CF-033 discovered failure preserved

## CF-033-F1 — adversarial outcome probes were initially coordinator-only

The first passing prototype rejected partial, incorrect and unknown outcomes by
raising coordinator errors, but did not first obtain those classifications from
the native family observers. That was too weak for the requested native fault
evidence.

The final sealed implementation creates isolated fault stores and exercises a
partial document observation, incorrect signed-message observation and unknown
database observation through the respective CF-007/008/009 native observer
implementations. The coordinator then rejects those native classifications.
No successful-item state or assertion was weakened; the implementation was
resealed before final verification.
