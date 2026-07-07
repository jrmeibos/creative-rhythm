function requireAuth(req, res, next) {
  if (!req.session.user) {
    // For page navigations, carry the destination through login so an
    // expired-session user lands back where they were headed (e.g. a
    // mid-checkout /upgrade visit). API fetches just get the redirect.
    if (req.method === 'GET' && req.accepts('html')) {
      return res.redirect('/?returnTo=' + encodeURIComponent(req.originalUrl));
    }
    return res.redirect('/');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/');
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).render('error', {
      title: 'Access Denied',
      message: "You don't have permission to view this page.",
      user: req.session.user,
      page: 'error'
    });
  }
  next();
}

module.exports = { requireAuth, requireAdmin };
