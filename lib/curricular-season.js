function getCurricularSeason(courseWeek) {
  if (courseWeek >= 1 && courseWeek <= 3)   return 'winter';
  if (courseWeek >= 4 && courseWeek <= 6)   return 'spring';
  if (courseWeek >= 7 && courseWeek <= 9)   return 'summer';
  if (courseWeek >= 10 && courseWeek <= 12) return 'autumn';
  return null;
}

const SEASON_LABELS      = { winter: 'Winter', spring: 'Spring', summer: 'Summer', autumn: 'Autumn' };
const SEASON_DESCRIPTORS = { winter: 'Connection inward', spring: 'Curiosity', summer: 'Creation', autumn: 'Sharing' };

function getCurricularSeasonLabel(season)      { return SEASON_LABELS[season]      || ''; }
function getCurricularSeasonDescriptor(season) { return SEASON_DESCRIPTORS[season] || ''; }

module.exports = { getCurricularSeason, getCurricularSeasonLabel, getCurricularSeasonDescriptor };
