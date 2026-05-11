const ANGLES = [
  {
    id: 'remembering',
    name: 'Remembering',
    subtitle: "Reaching back — what's still in you from before, what's still waiting",
    questions: [
      { id: 'r1', text: "What were you known for when you were little?" },
      { id: 'r2', text: "Are there hobbies that you used to love that you don't do anymore?" },
      { id: 'r3', text: "What did you used to spend hours doing that you'd be embarrassed to admit now?" },
      { id: 'r4', text: "What were you afraid of as a kid that you're not afraid of anymore? What are you afraid of now that you weren't?" },
      { id: 'r5', text: "Tell me about something you changed your mind about." },
      { id: 'r6', text: "What have you started and not finished?" },
      { id: 'r7', text: "What have you been telling yourself you'll do for years?" },
    ],
  },
  {
    id: 'noticing',
    name: 'Noticing',
    subtitle: "Present-tense attention — where your eye already goes",
    questions: [
      { id: 'n1', text: "Spend 5 minutes scrolling your saved videos. What themes or trends do you notice? What kind of content do you gravitate towards?" },
      { id: 'n2', text: "What do you find yourself bringing up in conversation, even when no one asked?" },
      { id: 'n3', text: "Whose work inspires a sense of slight jealousy? What specifically does that jealousy point at?" },
      { id: 'n4', text: "Where in your day do you feel most awake / alive?" },
      { id: 'n5', text: "If a stranger looked at your bookshelf, camera roll, and your phone home screen, what would they learn about you? What do you keep close?" },
      { id: 'n6', text: "What do you find yourself Googling at 11 PM that has nothing to do with work?" },
      { id: 'n7', text: "You get a check for $10,000, but with one rule — you HAVE to spend it on something fun, or you lose it. You can't save it or use it on debts or bills. How do you spend it?" },
    ],
  },
  {
    id: 'allowing',
    name: 'Allowing',
    subtitle: "What you'd say if you could — what's pressing against the surface",
    questions: [
      { id: 'a1', text: "Is there anybody who annoys or irritates you? Is there something they're allowing themselves to be that you feel you're not allowed to be?" },
      { id: 'a2', text: "If you knew that no one you know would see your content, what would you finally allow yourself to say?" },
      { id: 'a3', text: "What's something you believe that most people in your life would disagree with?" },
      { id: 'a4', text: "If you knew you couldn't fail, what would you choose to pursue?" },
      { id: 'a5', text: "What makes you angry on behalf of others?" },
      { id: 'a6', text: "What's a piece of advice that everyone gives that you think is wrong?" },
      { id: 'a7', text: "What conversation do you wish was happening?" },
    ],
  },
  {
    id: 'imagining',
    name: 'Imagining',
    subtitle: "Parallel selves — what other lives are in you",
    questions: [
      { id: 'i1', text: "If you could live 5 other lives, what would you try out? Would you try a different career or explore different hobbies?" },
      { id: 'i2', text: "If you were to give a TED Talk, what would your topic be?" },
      { id: 'i3', text: "What interests do you have that feel completely unrelated to your art / business / goal?" },
      { id: 'i4', text: "What would you do if you had a free Saturday with no obligations?" },
      { id: 'i5', text: "What do you wish existed that you haven't seen yet? (community, invention, societal mindset shifts, etc.)" },
      { id: 'i6', text: "If you could wake up tomorrow with a new fully formed skill, what would you choose? Why that one?" },
      { id: 'i7', text: "If you could apprentice under anyone for a year, who would it be?" },
    ],
  },
  {
    id: 'knowing',
    name: 'Knowing',
    subtitle: "Quiet expertise — what comes naturally, where you disappear",
    questions: [
      { id: 'k1', text: "What do friends always come to you for advice about?" },
      { id: 'k2', text: "What can you do without trying that other people seem to find hard?" },
      { id: 'k3', text: "What activities make time disappear for you?" },
      { id: 'k4', text: "What do strangers compliment you on that you'd shrug off?" },
      { id: 'k5', text: "What's something you could talk about for an hour with no prep?" },
      { id: 'k6', text: "What do you do that you assume is normal, but other people seem to find unusual?" },
      { id: 'k7', text: "What would you notice walking into a room that most people would miss?" },
    ],
  },
];

function getAngle(angleId) {
  return ANGLES.find(a => a.id === angleId) || null;
}

function getQuestion(angleId, questionId) {
  const angle = getAngle(angleId);
  if (!angle) return null;
  return angle.questions.find(q => q.id === questionId) || null;
}

module.exports = { ANGLES, getAngle, getQuestion };
