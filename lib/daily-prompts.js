// lib/daily-prompts.js
//
// Per-season daily topic pools for the Dashboard day-view.
// 21 prompts per curricular season (one per day of a 3-week / 21-day season),
// indexed 0..20 by day-within-season.
//
// IMPORTANT: array order = the day-by-day sequence a student walks through that
// season. Reorder freely — it's just position in the array. The mapping is fixed
// at module level (never randomized per request) so scrolling back to a past day
// always shows the same topic it showed that day.
//
// Single source of truth — do not duplicate these strings in templates or routes.

const DAILY_PROMPTS = {
  winter: [
    "What are you ultimately building toward in your life and work?",
    "What's a default in your industry that makes your nervous system scream?",
    "What lie did you believe early on that you've had to unlearn?",
    "What's an opinion you have that you're nervous to share?",
    "What moments shaped how you see the world?",
    "What's something you could give a TED talk on with no preparation?",
    "What makes you ranty?",
    "What kind of world do you want to help make possible — for you and the people you serve?",
    "Talk about a book or person who shifted your perspective.",
    "What's an idea that keeps resurfacing that you haven't talked about yet?",
    "Where do you feel protective of your people?",
    "What do you do differently that actually works?",
    "What's something you used to want that you don't want anymore?",
    "What would you say if you weren't worried about being misunderstood?",
    "What's a question you wish more people in your field were asking?",
    "What do you know now that you wish you'd known five years ago?",
    "What's a small thing you do that you're secretly proud of?",
    "What's a story you find yourself telling over and over? Why that one?",
    "What first pulled you toward your work/practice?",
    "Tell us about something you've been working on for a while.",
    "What are you still figuring out that you don't have a clean answer for yet?"
  ],
  spring: [
    "What's something you've changed your mind about recently?",
    "Describe the version of yourself that's running this business or practice five years from now. What's different?",
    "What's a piece of advice you got that turned out to be wrong for you?",
    "What's something obvious to you that other people in your field seem to miss?",
    "Talk about a moment when you felt most like yourself.",
    "What's a compliment you've received that you didn't believe? What about one that you did?",
    "What's a hill you'd die on professionally?",
    "What's something you've been told is \"just how it works\" that you don't accept?",
    "Describe a person who lives the way you'd like to live. What do they do that you don't?",
    "What's a fear that drives more of your decisions than you'd like to admit?",
    "What's something you used to be embarrassed about that you'd own now?",
    "What do you want your work to do for people that nobody else's work does?",
    "What's a tradition or convention you've quietly broken from? How's it going?",
    "What's a question you'd want a journalist to ask you?",
    "What's the most useful thing you've learned from someone you disagree with?",
    "What's a small daily decision that's shaped your life more than you expected?",
    "Describe a piece of work — yours or someone else's — that made you think \"I want to make things like that.\"",
    "What's something you're allowed to want, even if it's not what you're supposed to want?",
    "What are you building or chasing right now that excites you?",
    "A moment you surprised yourself by being good at something? What did you learn?",
    "What has recording yourself daily been like so far?"
  ],
  summer: [
    "Three things you wish more people in your field knew.",
    "The most overrated and most underrated tool in your toolkit.",
    "A small thing you do every day that other people seem to find weird.",
    "Walk through your favorite project you've ever worked on. What made it good?",
    "The worst piece of advice you've ever been given — and why.",
    "Three rules you actually follow in your work. Where did each come from?",
    "The hill you'd die on about your craft.",
    "Something you used to think was important that you've realized doesn't matter.",
    "What is an unpopular opinion you have about your field? Defend it.",
    "The thing you nerd out about that has nothing to do with your work.",
    "A trend you're tired of. A trend you're rooting for.",
    "The first thing you'd tell someone who wanted to start doing what you do.",
    "A mistake you keep watching other people make.",
    "Your favorite weird hack, ritual, or workflow.",
    "A habit or routine of yours that surprises people.",
    "A moment in your career when you finally trusted yourself.",
    "The book, podcast, or person you recommend to everyone — and why.",
    "A small luxury or detail that makes a disproportionate difference.",
    "Record an update to one specific friend — tell them a story from this week.",
    "Teach one small thing you know, start to finish, like a 60-second how-to.",
    "What are five things you would tell yourself from 5 years ago?"
  ],
  autumn: [
    "A piece of conventional wisdom you think is actually wrong.",
    "A pattern you've watched play out in the lives of people you care about. What it taught you.",
    "The most useful framework you've built for making hard decisions.",
    "A pattern you've noticed in successful people that nobody talks about.",
    "Something you've come to believe through experience that you couldn't have learned any other way.",
    "Something most people treat as a sign of failure that you read differently.",
    "The kind of person you've come to trust. The kind you've learned not to.",
    "What you think the next decade will reveal about the way we live now.",
    "Someone you'd consider a quiet teacher in your life. What you've learned from watching them.",
    "Something you've stopped apologizing for. Why you used to.",
    "The advice you give that nobody asks for but you can't help giving.",
    "A definition you'd argue with. (Of success, of love, of rest, of ambition, etc.)",
    "A question you ask yourself when you don't know what to do.",
    "A way of thinking you'd want to pass on if you could only pass on one thing.",
    "Something you used to dismiss that you've come to respect.",
    "The question you think more people should be asking about how they spend their time.",
    "A trade-off you're making right now that you've decided you're okay with.",
    "A belief you hold loosely that you used to hold tightly.",
    "What are the core values that show up consistently in your life and in your work?",
    "How do you think young you would feel about current you, if they got the chance to meet?",
    "Tell us about something you've been curious about lately."
  ]
};

function getDailyPrompt(season, dayInSeason) {
  const pool = DAILY_PROMPTS[season];
  if (!pool || !pool.length) return null;
  const i = ((dayInSeason % pool.length) + pool.length) % pool.length;
  return pool[i];
}

module.exports = { DAILY_PROMPTS, getDailyPrompt };
