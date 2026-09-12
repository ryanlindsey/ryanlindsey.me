# Raw notes: the queue backlog incident

Unstructured. For turning into the opening and Context section of a case study.

- Cloudflare Queue consumer for the telemetry ingest pipeline. Batch size 10, max_retries 3.
- A malformed capture file from one driver caused the consumer to throw before acking.
- Retried 3 times, then went to the DLQ. Fine so far, that is the design.
- The problem: the DLQ had no alarm on it. Nothing watched depth.
- Discovered 11 days later, when a driver asked why a session from the 2nd never produced a debrief.
- 47 sessions in the DLQ by then. 6 drivers affected, not 1.
- Queue dashboard showed the consumer as healthy the whole time. Success rate 99.4%, because the successes were counted and the dead letters were not in the denominator.
- Cost to fix the actual parse bug: about 20 minutes, one null check.
- Cost of the 11 days: replaying 47 captures, and a conversation with each of the 6 drivers.
- I now have a scheduled Worker that reports DLQ depth daily and pages if depth > 0 for two consecutive checks.
- Wider point: the dashboard answered "is the consumer running" when the question I actually had was "is any work being lost". Those are different questions and I had not noticed I was reading the answer to the wrong one.
- Related to the 639 sessions thing from the other case study, same family. A green signal that was measuring the wrong denominator.
- Roster at the time: 4 drivers on the paid tier plus 2 on trial.
