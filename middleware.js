function verifyBearerToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    
    if (!authHeader) {
      return res.status(401).send('Authorization header is missing');
    }
  
    const token = authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).send('Token is missing');
    }

    if (token !== process.env.AUTH_TOKEN) {
        return res.status(401).send('Token is invalid');
    }
  
    next();
}

module.exports = {
  verifyBearerToken
};
