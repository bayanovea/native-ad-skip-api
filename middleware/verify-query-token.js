// Admin GET endpoints called from Grafana data links take AUTH_TOKEN as the
// ?verifyBearerToken= query param. Put this before any validator so a wrong
// token is a 401 whatever the other params are.
function verifyQueryToken(req, res, next) {
    if (req.query.verifyBearerToken !== process.env.AUTH_TOKEN) {
        res.status(401).send('Unauthorized');
        return;
    }
    next();
}

module.exports = verifyQueryToken;
