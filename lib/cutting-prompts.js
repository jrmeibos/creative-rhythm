// Daily cutting field definitions — single source of truth for the four
// reflection prompts. Imported by:
//   - server.js /dashboard/cutting route (validates payload by key)
//   - views/dashboard.ejs (renders the form)
//   - views/greenhouse-cuttings.ejs (archive cards)
//   - views/exports/cuttings-pdf.ejs (PDF entries)
// Add a new prompt by appending here; everything else picks it up.
// `key` must match the column name on the cuttings table.
const CUTTING_PROMPTS = [
  { key: 'reflection_text', label: 'What did you notice today?',                 help: 'A sentence is plenty — or skip it.' },
  { key: 'talked_about',    label: 'What did you talk about today?' },
  { key: 'how_it_felt',     label: 'How did it go? How did it feel?' },
  { key: 'takeaway',        label: 'Any takeaways you want to remember for later?' },
];

module.exports = CUTTING_PROMPTS;
