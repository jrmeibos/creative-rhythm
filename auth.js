function requireAuth(req, res, next) {
  if (!req.session.user) {
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
