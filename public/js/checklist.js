// The prep checklist a new event's list starts from.
//
// Its own module rather than a constant in app.js so the cross-language fixture
// (`contracts/logic/checklist.json`) can import it: the iOS app carries a port of
// this list (`EventDates.DEFAULT_CHECKLIST`), and two hand-maintained copies of
// the same product decision drift the first time one is edited.
//
// This is only the fallback. A user who edits the list in Settings gets their own,
// stored server-side as `users.checklist_template` and served by `GET /api/me`.

export const DEFAULT_CHECKLIST = [
  // First because it is the only item with a deadline days before the event
  // rather than the morning of it.
  "Purchase Track insurance",
  "Tech inspection",
  "Torque lug nuts",
  "Check brake pads & fluid",
  "Set tire pressures",
  "Top off fuel",
  "Pack helmet & gloves",
  "Empty the car — remove loose items",
  "Charge camera / lap timer",
];
