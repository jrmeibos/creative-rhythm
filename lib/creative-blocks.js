// Built-in "Creative Block Buster" content — the curated blocks every
// student starts with, each paired with a few gentle "ways through."
// Students layer their own options on top (and add their own blocks, and
// hide the ones that don't apply) via the block_buster_* tables; those are
// stored per-user. This file is just the shared starting point.
//
// Each block has a STABLE `slug` — it's the key student-added options and
// hides reference, so don't rename slugs once students have data. Editing
// title/options text is safe; changing a slug orphans a student's additions.

const CREATIVE_BLOCKS = [
  {
    slug: 'not-attractive-enough',
    title: "I don't feel attractive enough to be on camera",
    options: [
      "Film anyway — and show yourself you don't have to look a certain way to show up.",
      "Film some POV footage instead — your hands, your workspace, what you're looking at.",
      "Spend your time editing something today instead of filming.",
      "Record a voice note you can lay over a reel later.",
    ],
  },
  {
    slug: 'nothing-to-say',
    title: "I don't know what to say today",
    options: [
      "Talk about the fact that you don't know what to say. It's often the most honest thing you'll make.",
      "Film your process with no talking — let the doing be the content.",
      "Share one thing you noticed today, however small.",
      "Read something that moved you and say why.",
    ],
  },
  {
    slug: 'afraid-of-judgment',
    title: "I'm scared of being judged",
    options: [
      "Film it just for your own archive — no posting required.",
      "Talk to one specific person, not 'an audience.'",
      "Record audio only for now; the visual can come later.",
      "Film somewhere you feel safe and unwatched.",
    ],
  },
  {
    slug: 'no-energy',
    title: "I don't have the energy today",
    options: [
      "Do the smallest possible version — ten seconds counts.",
      "Hit record and ramble. No pressure to ever use it.",
      "Rest, and edit something you already filmed instead.",
      "Jot down one caption idea to plant for later.",
    ],
  },
  {
    slug: 'dont-like-playback',
    title: "I don't like how I look or sound on playback",
    options: [
      "Watch it back on mute first — read your body without the pressure of your voice.",
      "Give it a week before you decide. Distance changes everything.",
      "Turn it into POV or hands-only footage.",
      "Pull the audio and pair it with a still image.",
    ],
  },
  {
    slug: 'been-said-before',
    title: "It's all been said before",
    options: [
      "Say it in your words — that's the part that hasn't been said.",
      "Tell the specific story only you have.",
      "Turn it into a question and ask your community instead.",
    ],
  },
];

module.exports = { CREATIVE_BLOCKS };
