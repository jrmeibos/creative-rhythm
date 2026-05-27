// Daily recording-card content, keyed by curricular season slug.
// Slugs match lib/curricular-season.js: winter | spring | summer | autumn.
// Edit copy here; the dashboard view reads from this module.
const SEASON_PROMPTS = {
  winter: {
    shortPrompt: "What's there today? Talk to the camera for as long or as little as feels honest. No one ever has to see this.",
    aboutText:   "This is our season of experimenting and becoming acquainted with who we are when there is a camera on. We're building the practice itself, not the polish. No one ever has to see these videos."
  },
  spring: {
    shortPrompt: "What's true for you today? Talk for as long or as little as feels honest — then watch it back.",
    aboutText:   "We'll continue our daily mind-dump video practice, with one added element. Now, you'll watch what you filmed right after you finish. We are warming up to the idea of allowing ourselves to be seen, starting with an audience of one. (You) 😌"
  },
  summer: {
    shortPrompt: "What do you want to make today? Talk to the camera with intention.",
    aboutText:   "Our recordings are shifting into creations. Now, we will spend a little more time with our daily recording sessions. Pull your video into a video editing program and trim it. We'll notice in this season what editing adds to the mix energetically."
  },
  autumn: {
    shortPrompt: "What's ready to be seen? Record, edit, and share — with the group or with the world.",
    aboutText:   "In Fall, we will approach the final step in the creative's journey — visibility through sharing. Whether sharing with the group or publicly, this season offers a safe opportunity to observe how our bodies respond to sharing."
  }
};

function getSeasonPrompt(season) {
  return SEASON_PROMPTS[season] || null;
}

module.exports = { SEASON_PROMPTS, getSeasonPrompt };
