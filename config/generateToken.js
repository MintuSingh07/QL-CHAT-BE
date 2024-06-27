const jwt = require('jsonwebtoken');

const generateToken = (user) => {
  const { _id, email, userName, pic } = user;
  return jwt.sign({ _id, email, userName, pic }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });
};

module.exports = generateToken;
