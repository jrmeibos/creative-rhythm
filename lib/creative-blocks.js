// Built-in content for "The Creative Block Buster" — organized as
// CATEGORIES → blocks → "ways through." The page reads like a flow chart:
// name what you're feeling (a block), and it opens to a few ways through it.
// Students layer their own options on top, add their own blocks (filed into
// one of these categories), and hide the ones that don't apply — all stored
// per-user in the block_buster_* tables. This file is the shared starting
// point everyone begins with.
//
// STABLE keys: each category has a `slug` and each block has a `slug`. They're
// the keys student-added options and hides reference — safe to edit titles and
// option text, but don't rename a slug once students have data (it orphans
// their additions). Custom blocks use the key 'custom-<id>' and carry their
// own category.

const CREATIVE_BLOCK_CATEGORIES = [
  {
    slug: 'blank-page',
    name: 'Blank Page Panic',
    descriptor: 'Idea scarcity',
    blocks: [
      {
        slug: 'nothing-to-say',
        title: "I don't know what to say — I don't have any ideas",
        options: [
          "Talk about the fact that you don't know what to say. It's often the most honest thing you'll make.",
          "Film your process with no talking — let the doing be the content.",
          "Share one small thing you noticed today.",
          "Open your camera roll or notes app and react to something already there.",
        ],
      },
      {
        slug: 'who-am-i-online',
        title: "I don't know who I want to be online yet",
        options: [
          "You don't have to know yet. Film like it's a journal, not a brand — the throughline shows up later.",
          "Talk about the thing you can't stop thinking about this week. That's a clue.",
          "Try one post as each 'version' of you, and notice which one felt most like home.",
        ],
      },
      {
        slug: 'hoarding-best-ideas',
        title: "I don't want to share my best ideas — what if I run out?",
        options: [
          "Ideas aren't a finite jar. Sharing one usually shakes three more loose.",
          "Share the idea; keep the deepest execution for your paid work. The idea isn't the moat — you are.",
          "Give the 'what,' save the full 'how' for later. You can be generous and still hold something back.",
        ],
      },
      {
        slug: 'nothing-exciting',
        title: "Nothing exciting enough to film is happening",
        options: [
          "The ordinary is the content — film the coffee, the walk, the small ritual.",
          "Talk about a past moment instead of a present one. Memory counts.",
          "Record a POV of whatever's in front of you right now. No 'event' required.",
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
    ],
  },
  {
    slug: 'overwhelm',
    name: 'Overwhelm Block',
    descriptor: 'Too many choices',
    blocks: [
      {
        slug: 'too-many-ideas',
        title: "I don't know what to say — I have too many ideas",
        options: [
          "Pick the one you'd still care about tomorrow. The rest go in a list, not the bin.",
          "Set a two-minute timer and start with whichever idea is loudest right now.",
          "Brain-dump all of them into one voice note, then choose later.",
        ],
      },
      {
        slug: 'too-much-to-edit',
        title: "I have too much to edit and don't know where to start",
        options: [
          "Start with the clip you already like — momentum beats order.",
          "Edit one, post one. Don't let the pile become the project.",
          "Set a 20-minute timer and only touch one video.",
        ],
      },
      {
        slug: 'too-busy',
        title: "I'm too busy",
        options: [
          "Do the ten-second version. Showing up small still counts.",
          "Batch it — film three quick clips in one sitting so future-you is covered.",
          "Record a voice note between tasks; you can build on it later.",
        ],
      },
    ],
  },
  {
    slug: 'critic-clash',
    name: 'Critic Clash',
    descriptor: 'Perfectionism & overthinking',
    blocks: [
      {
        slug: 'imposter-syndrome',
        title: "Imposter syndrome — who am I to talk about this?",
        options: [
          "You're not claiming to be the expert; you're sharing the view from where you're standing. That's allowed.",
          "Talk to the person one step behind you. You know more than they do.",
          "Say 'here's what I'm learning' instead of 'here's the answer.'",
        ],
      },
      {
        slug: 'not-attractive-enough',
        title: "I don't feel attractive enough — my inner critic won't let me on camera",
        options: [
          "Film anyway — and show yourself you don't have to look a certain way to show up.",
          "Film some POV footage instead — your hands, your workspace, what you're looking at.",
          "Spend your time editing something today instead of filming.",
          "Record a voice note you can lay over a reel later.",
        ],
      },
      {
        slug: 'nothing-valuable',
        title: "I don't have anything valuable to share",
        options: [
          "Value isn't only teaching — a feeling, a question, or a true story is valuable too.",
          "Share the thing you wish someone had told you a year ago.",
          "Ask your people a question instead of answering one.",
        ],
      },
      {
        slug: 'what-will-people-think',
        title: "What will people think? What will they say?",
        options: [
          "Film it just for your own archive first — no posting required.",
          "Talk to one specific person who's rooting for you, not 'everyone.'",
          "Name the fear out loud in the video. It usually loses its grip.",
        ],
      },
    ],
  },
  {
    slug: 'burnout',
    name: 'Burnout Block',
    descriptor: 'Mental & physical fatigue',
    blocks: [
      {
        slug: 'too-tired',
        title: "I'm too tired",
        options: [
          "Rest is allowed. Edit something you already filmed instead of making new.",
          "Do the smallest possible version, then stop.",
          "Skip today on purpose — a chosen rest isn't falling behind.",
        ],
      },
      {
        slug: 'dont-want-to',
        title: "I don't want to",
        options: [
          "Don't force it. Jot down one idea to plant for later, and close the laptop.",
          "Ask why — is it rest you need, or is the format wrong? Try a different medium.",
          "Set a two-minute timer; if you still don't want to when it ends, you're free to stop.",
        ],
      },
    ],
  },
  {
    slug: 'comparison-trap',
    name: 'Comparison Trap',
    descriptor: 'Discouragement & comparison',
    blocks: [
      {
        slug: 'comparing-myself',
        title: "I keep comparing myself to other creators",
        options: [
          "Mute or unfollow the accounts that make you spiral — at least for today.",
          "Their highlight reel isn't their whole story, and it isn't yours.",
          "Compare yourself to your own work from six months ago instead. That's the honest one.",
        ],
      },
      {
        slug: 'nothing-happens',
        title: "I post and nothing happens — why bother?",
        options: [
          "Reach isn't the only point; the reps are changing you, seen or not.",
          "One right person beats a thousand scrolls. Make it for them.",
          "Check whether you're measuring the thing you actually care about.",
        ],
      },
      {
        slug: 'feel-behind',
        title: "I feel behind — everyone's ahead of me",
        options: [
          "There's no timetable here. You're in your own season, not theirs.",
          "Name one thing you can do today that you couldn't a month ago.",
          "Behind whom? The comparison is usually invented. Come back to your next small step.",
        ],
      },
    ],
  },
];

// Flat lookup of built-in category slugs (used to validate a custom block's
// category server-side).
const CATEGORY_SLUGS = CREATIVE_BLOCK_CATEGORIES.map(c => c.slug);

module.exports = { CREATIVE_BLOCK_CATEGORIES, CATEGORY_SLUGS };
