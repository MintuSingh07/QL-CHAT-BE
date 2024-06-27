const jwt = require('jsonwebtoken');
const User = require('../models/user.model');

const getUserFromToken = async (token) => {
    try {
        if (token) {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const loggedinUser = await User.findById(decoded._id).select("-password");
            return loggedinUser;
        }
        return null;
    } catch (error) {
        console.error('Token verification failed:', error);
        return null;
    }
};

const context = async ({ req }) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split(' ')[1];
    const user = await getUserFromToken(token);
    return { user, req };
};

module.exports = context;
