/* eslint-disable class-methods-use-this */
import { hashPassword } from '../../lib/utils';

export default class Accounts {
  constructor(connection) {
    this._connection = connection;
  }

  createUser(options, callback = () => {}) {
    if (options.username) options.username = options.username;
    if (options.email) options.email = options.email;

    // Replace password with the hashed password.
    options.password = hashPassword(options.password);

    this._connection._startLoggingIn();
    this._connection.call('createUser', options, (err, result) => {
      this._connection._endLoggingIn();

      this._connection._handleLoginCallback(err, result);

      callback(err);
    });
  }

  changePassword(oldPassword, newPassword, callback = () => {}) {
    // TODO: check Meteor.user() to prevent if not logged
    if (typeof newPassword != 'string' || !newPassword) {
      return callback('Password may not be empty');
    }

    this._connection.call(
      'changePassword',
      oldPassword ? hashPassword(oldPassword) : null,
      hashPassword(newPassword),
      (err, res) => {
        callback(err);
      }
    );
  }

  forgotPassword(options, callback = () => {}) {
    if (!options.email) {
      return callback('Must pass options.email');
    }

    this._connection.call('forgotPassword', options, err => {
      callback(err);
    });
  }

  resetPassword(token, newPassword, callback = () => {}) {
    if (!newPassword) {
      return callback('Must pass a new password');
    }

    this._connection.call(
      'resetPassword',
      token,
      hashPassword(newPassword),
      (err, result) => {
        if (!err) {
          this._connection._loginWithToken(result.token);
        }

        callback(err);
      }
    );
  }

  onLogin(cb) {
    this._connection.on('onLogin', cb);
  }

  onLoginFailure(cb) {
    this._connection.on('onLoginFailure', cb);
  }
}
