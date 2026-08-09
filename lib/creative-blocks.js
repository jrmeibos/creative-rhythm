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
        title: `I don't know what to say / I don't have any ideas`,
        options: [
          `Talk about the fact that you don't know what to say.`,
          `Film your process with no talking. Try doing only B-roll today.`,
          `What have you talked about with your friends/colleagues recently? Is there something to share in there?`,
          `Open your camera roll or notes app and react to something already there.`,
        ],
      },
      {
        slug: 'who-am-i-online',
        title: `I don't know who I want to be online yet`,
        options: [
          `You don't have to know yet. Film like it's a journal entry. It's okay to show up in process.`,
          `Talk about the thing you can't stop thinking about this week. That's a clue.`,
          `Try to film something as a character. Start figuring out who you are by trying out who you're not.`,
        ],
      },
      {
        slug: 'hoarding-best-ideas',
        title: `I don't want to share my best ideas — what if I run out?`,
        options: [
          `Ideas aren't a finite jar. Sharing one usually shakes three more loose.`,
          `Share the idea; keep the deepest execution for your paid work. The idea isn't the moat — you are.`,
          `Give the 'what,' save the full 'how' for later. You can be generous and still hold something back.`,
        ],
      },
      {
        slug: 'nothing-exciting',
        title: `Nothing exciting enough to film is happening`,
        options: [
          `The ordinary stuff is often the content we need most. Film some b-roll of your normal routine.`,
          `Talk about a past moment instead of a present one.`,
          `Record a POV of whatever's in front of you right now. One day, time may make its normalcy magic.`,
        ],
      },
      {
        slug: 'been-said-before',
        title: `It's all been said before`,
        options: [
          `But YOU haven't said it before. And nobody can say it exactly like you will. Give it a try anyway.`,
          `Tell the specific story only you have.`,
          `Turn it into a question and ask your community for feedback instead.`,
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
        title: `I don't know what to say — I have too many ideas`,
        options: [
          `Pick the one you'd still care about tomorrow. The rest go in a list, not the bin.`,
          `Set a two-minute timer and start with whichever idea is loudest right now.`,
          `Brain-dump all of them into one voice note, then choose later.`,
        ],
      },
      {
        slug: 'too-much-to-edit',
        title: `I have too much to edit and don't know where to start`,
        options: [
          `Let momentum rule! Start with the clip you already like.`,
          `Edit one post only. Don't let the pile become a full-day project.`,
          `Set a 20-minute timer and only touch one video. Then go for a walking break. When you come back, do you still want to keep working?`,
        ],
      },
      {
        slug: 'too-busy',
        title: `I'm too busy`,
        options: [
          `Do the low-effort, ten-second version. Showing up small still counts.`,
          `Film some b-roll of your busy day. It truly only takes seconds. (And a reminder on your phone so you remember to do it)`,
          `Plan 5 short minutes to do it between tasks.`,
          `If you are truly too busy, it is okay to take days off! Consistency can look inconsistent.`,
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
        title: `Imposter syndrome — who am I to talk about this?`,
        options: [
          `Instead of claiming to be an expert, share authentically from your perspective.`,
          `Talk to the version of you from a year ago. You know more than they do.`,
          `Say 'here's what I'm learning' instead of 'here's the answer.'`,
        ],
      },
      {
        slug: 'not-attractive-enough',
        title: `I don't feel _____ enough / my inner critic won't let me on camera`,
        options: [
          `If you film anyway, you give yourself an opportunity to show yourself that you don't have to look a certain way to show up.`,
          `Film some POV footage instead. (your hands, your workspace, what you're looking at)`,
          `Spend your time editing something today instead of filming.`,
          `Record a voice note instead of a video.`,
        ],
      },
      {
        slug: 'nothing-valuable',
        title: `I don't have anything valuable to share`,
        options: [
          `Value isn't only teaching — a feeling, a question, or a true story is valuable too.`,
          `Share the thing you wish someone had told you a year ago.`,
          `Ask your people a question instead of answering one.`,
        ],
      },
      {
        slug: 'what-will-people-think',
        title: `What will people think? What will they say?`,
        options: [
          `Film it just for you first. That will help it be true and authentic. Then, decide what to do or not do with it later.`,
          `Talk to one specific person who's rooting for you, not 'everyone.'`,
          `Name the fear out loud while recording the video. "I'm scared to say ____ because _____." It usually loses its grip.`,
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
        title: `I'm too tired`,
        options: [
          `Rest is allowed. Days off are allowed.`,
          `If you still want to show up, but in a different way, edit something you already filmed instead of making new.`,
          `Do the smallest possible version, then stop.`,
          `Skip today on purpose — a chosen rest isn't falling behind.`,
        ],
      },
      {
        slug: 'dont-want-to',
        title: `I don't want to`,
        options: [
          `Ask why — is it rest you need, or is the format wrong? Try a different medium.`,
          `Set a two-minute timer; if you still don't want to when it ends, you're free to stop.`,
          `Don't force it. It's okay to take days off, especially if that means you'll come back with more vigor tomorrow.`,
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
        title: `I keep comparing myself to other creators`,
        options: [
          `Mute or unfollow the accounts that make you spiral. It is not worth the negative feelings.`,
          `Recognize that they may be showing you something that you subconsciously want but may not feel you have access to. Is there something to learn from this uncomfortable feeling? Sit with it for a moment.`,
          `Can you find some of their earlier content? Maybe you can see how they've grown. Allow yourself the same trajectory. It's okay to be where you're at.`,
        ],
      },
      {
        slug: 'nothing-happens',
        title: `I post and nothing happens... why bother?`,
        options: [
          `Reach isn't the only point; the reps are changing you, seen or not.`,
          `One right person beats a thousand scrolls. Make it for them.`,
          `Check whether you're measuring the thing you actually care about. Community is way more valuable than metrics.`,
        ],
      },
      {
        slug: 'feel-behind',
        title: `I feel behind / everyone's ahead of me`,
        options: [
          `There's no timetable here. You're in your own season, not theirs.`,
          `Name one thing you can do today that you couldn't a month ago.`,
        ],
      },
    ],
  },
];

// Flat lookup of built-in category slugs (used to validate a custom block's
// category server-side).
const CATEGORY_SLUGS = CREATIVE_BLOCK_CATEGORIES.map(c => c.slug);

module.exports = { CREATIVE_BLOCK_CATEGORIES, CATEGORY_SLUGS };
