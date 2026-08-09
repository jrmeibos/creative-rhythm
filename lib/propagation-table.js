// The Propagation Table — a Summer challenge. Students take their season's
// worth of "cuttings" (recordings) and their idea bank and propagate them into
// eight kinds of shareable content, climbing from the gentlest format (a Story
// that's gone in a day) to the boldest (their own TED talk).
//
// This is an OPEN menu, not a locked ladder: every rung is available, students
// start wherever feels doable, and progress is tracked per rung (not tied to a
// specific cutting) in the propagation_makes table. It sits on top of the
// existing Summer format buffet, which stays untouched.
//
// STABLE slugs: each rung's `slug` is the key propagation_makes rows reference.
// Safe to edit titles/copy; don't rename a slug once students have progress.

// Guide copy uses \n\n between paragraphs; the view splits on that.
const PROPAGATION_INTRO =
  `Every recording you've made this season is a cutting. What's amazing about them is that they all come from YOU. They're your ideas that we've set aside to root.\n\n` +
  `The Propagation Table is here to challenge you to turn these ideas into 7 different kinds of content. You don't have to do them in order, and you don't have to do them all today. Start wherever feels doable.\n\n` +
  `The only rule is that we will make the first six creations from what we already have, because I promise that you already have everything you need in your camera roll, your cuttings, and your creative noggin. Thankfully, we don't need to start from scratch because we've already done the hard part. Now, we cultivate it into something we're ready for others to see.\n\n` +
  `Let's get started.`;

const PROPAGATION_FINISH =
  `You did it.\n\n` +
  `From a Story that vanished in a day to your own TED talk. You know how to cultivate your own ideas into shareable content. All of these formats are repeatable and can be used time and time again. Congratulations, dear gardener!`;

const PROPAGATION_RUNGS = [
  {
    slug: 'static-post',
    emoji: '🖼️',
    title: 'Static post',
    subtitle: 'In-feed · image + caption',
    guide:
      `There are two ways you can achieve your first in-feed post. Was there a line you said in one of your videos that stuck out to you? Consider sharing it in a simple designed post. (Canva is my go-to editor for this, but you can use whatever you are most familiar with.)\n\n` +
      `Designing not your thing? It doesn't have to be. Scroll through your camera roll and pick a photo. It doesn't matter when it was taken, and it doesn't matter what it's of. Then, share a caption with an idea inspired by something you shared in one of your daily videos.`,
  },
  {
    slug: 'carousel',
    emoji: '🎠',
    title: 'Carousel',
    subtitle: 'Swipeable cards',
    guide:
      `A "Carousel" is a few stacked cards someone swipes through. Find an idea in your cuttings with a little more to it. For example, a story with beats, an idea that is easy to break out into a list, or something that has instructions/steps to it.\n\n` +
      `Slide one is the hook, and then the middle slides will carry the substance. You already worked the idea out on the camera. Now, we're working it out in a different format. Feel free to venture from what you said in your cutting; it may have started as a specific idea, but it can grow wherever you allow it to.`,
  },
  {
    slug: 'text-over-reel',
    emoji: '📝',
    title: 'Text-over-video reel',
    subtitle: 'Your footage · words on top',
    guide:
      `The first video we post will use your footage with text laid over the top. Choose a cutting or some behind-the-scenes footage and put a line of text over it: the point, the feeling, the one thought you'd want someone to catch.`,
  },
  {
    slug: 'voice-over-reel',
    emoji: '🎙️',
    title: 'Voice-over reel',
    subtitle: 'Your voice · footage on top',
    guide:
      `Choose a cutting with a message that you really want to share. We're going to use only your voice from this clip. Trim the audio down until your message is clear. Then, go through your camera roll and find videos to put on top of your voiceover. Bonus points if you are able to add captions on top of the video.`,
  },
  {
    slug: 'share-a-thought',
    emoji: '💬',
    title: 'Share a Thought',
    subtitle: 'Talk-to-camera · 15–30 seconds',
    guide:
      `Let's share a small thought, about the length of telling someone one quick thing across a table. If possible, take it directly from a cutting that you've already recorded.`,
  },
  {
    slug: 'share-a-story',
    emoji: '📖',
    title: 'Share a Story',
    subtitle: 'Talk-to-camera · 30–60 seconds',
    guide:
      `Find a cutting with a story worth sharing. We're still sharing one idea, but this time, the content has more room to breathe.`,
  },
  {
    slug: 'share-a-message',
    emoji: '🎤',
    title: 'Share a Message',
    subtitle: '🏆 Boss level · your TED talk · 1–3 min',
    boss: true,
    guide:
      `This one is a little different because it doesn't come from anything pre-recorded. Instead, it comes from ALL of it, and all of you. By now you may have a better awareness of what is easy for you to talk about. Or perhaps you have figured out your "why" — what is worth showing up online for, even though it is hard. Talk about that, for one to three minutes.\n\n` +
      `And here's a note: PLEASE forget the algorithm. Forget the views. Many platforms don't prioritize long-form videos. To that, I say, who cares. This one isn't for them. (None of it is.) It's for you, and for the version you become from making it.`,
  },
];

module.exports = { PROPAGATION_RUNGS, PROPAGATION_INTRO, PROPAGATION_FINISH };
