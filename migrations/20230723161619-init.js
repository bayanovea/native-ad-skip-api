'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up (queryInterface, Sequelize) {
    await queryInterface.createTable('user', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      }
    });

    await queryInterface.createTable('video', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      native_id: {
        type: Sequelize.CHAR(20),
        unique: true
      }
    });

    await queryInterface.createTable('video_calculated', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      video_id: {
        type: Sequelize.CHAR(20),
        references: {
          model: 'video',
          key: 'id'
        }
      },
      data: {type: Sequelize.JSON}
    });

    await queryInterface.createTable('markup_category_id', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      category: {
        type: Sequelize.ENUM('sponsor', 'subscribe')
      },
    });

    await queryInterface.createTable('markup', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      video_id: {
        type: Sequelize.CHAR(20),
        references: {
          model: 'video',
          key: 'id'
        }
      },
      user_id: {
        type: Sequelize.INTEGER,
        references: {
          model: 'user',
          key: 'id'
        }
      },
      category_id: {
        type: Sequelize.INTEGER,
        references: {
          model: 'markup_category_id',
          key: 'id'
        }
      },
    });

    await queryInterface.createTable('markup_time_interval', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      markup_id: {
        type: Sequelize.INTEGER,
        references: {
          model: 'markup',
          key: 'id'
        }
      },
      start: {
        type: Sequelize.INTEGER
      },
      end: {
        type: Sequelize.INTEGER
      }
    });
  },

  async down (queryInterface, Sequelize) {
    await queryInterface.dropTable('markup_time_interval');
    await queryInterface.dropTable('markup');
    await queryInterface.dropTable('markup_category_id');
    await queryInterface.dropTable('video_calculated');
    await queryInterface.dropTable('video');
    await queryInterface.dropTable('user');
  }
};
