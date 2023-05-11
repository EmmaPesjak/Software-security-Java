// const { verifyToken } = require('../token.js');

module.exports = function(db, app, createToken, verifyToken, sessionIds, csrfTokens, limiter, postSchema, body, validationResult) {

  //TODO verify CSRF in all (or atleast POST etc) endpoints

  //* GET
  /**
   * Retrieves all posts.
   */
  app.get('/api/users/:userName/posts', (req, res) => {
    const userName = req.params.userName;

    // Validates session.
    if (!req.body.debug && (!sessionIds.has(userName) || req.cookies.ID !== sessionIds.get(userName))) {
      return res.status(401).json({"error":'No active session.'});
    }

    // The SQL query to retrieve all posts..
    const sql = `
    SELECT p.*, u.username, u.name,
    (SELECT COUNT(l.user) FROM like AS l WHERE l.post = p.postId) AS likes,
    (SELECT COUNT(d.user) FROM dislike AS d WHERE d.post = p.postId) AS dislikes,
    CASE WHEN (SELECT l.user FROM like AS l WHERE l.post = p.postId AND l.user = u.userId) IS NULL
      THEN 0
      ELSE 1
    END AS likedByUser,
    CASE WHEN (SELECT d.user FROM dislike AS d WHERE d.post = p.postId AND d.user = u.userId) IS NULL
      THEN 0
      ELSE 1
    END AS dislikedByUser
    FROM post AS p, user AS u
    WHERE p.user = u.userId
    `;

    // Prepares the SQL statement.
    const stmt = db.prepare(sql);

    // Executes the prepared statement and returns the result.
    stmt.all(function(err, rows) {
      if (err) {
        console.error(err.message);
        res.status(500).json('Internal Server Error.');
      } else {
        res.status(200).json(rows);
      }
    });

    // Finalizes the prepared statement to release its resources.
    stmt.finalize();
  });

  //* GET
  /**
   * Retrieves the specified post.
   */
  app.get('/api/posts/:postId', (req, res) => {
    const postId = req.params.postId;

    // The SQL query to retrieve the specified post. Join username, likes, and dislikes with post.
    const sql = `SELECT p.*, u.username, u.name,
    COUNT(DISTINCT like.user) AS likes,
    COUNT(DISTINCT dislike.user) AS dislikes
    FROM post AS p
    JOIN user AS u ON p.user = u.userId
    LEFT JOIN like ON p.postId = like.post
    LEFT JOIN dislike ON p.postId = dislike.post
    WHERE p.postId = ?
    GROUP BY p.postId
    `;

    // Prepares the SQL statement.
    let stmt = db.prepare(sql);

    // Binds the parameters to the prepared statement.
    stmt.bind(postId);

    // Executes the prepared statement and returns the result.
    stmt.get((err, row) => {
      if (err) {
        console.error(err.message);
        res.status(500).json({"error": "Internal Server Error."});
      } else if (!row) {
        res.status(404).send('Post not found');
      } else {
        res.status(200).json(row);
      }
    });

    // Finalizes the prepared statement to release its resources.
    stmt.finalize();
  });

  //* POST
  /**
   * Creates a post.
   */
  app.post('/api/posts', limiter, [
    body('content').trim().escape()
  ], (req, res) => {

    // Catch potential <html> and javascript code.
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ errors: errors.array() });
    }

    // Validate user input against the Joi schema.
    const validationJoi = postSchema.validate(req.body);
    if (validationJoi.error) {
      return res.status(400).json({error: validationJoi.error.details[0].message});
    }

    // Get validated fields from Joi.
    const {content} = validationJoi.value;

    // Check if csrf-token match.
    const csrfToken = req.cookies.csrfToken;
    if (req.headers['x-csrf-token'] !== csrfToken) {
      return res.status(403).send({ error: 'CSRF token mismatch' });
    }

    // If the jwtToken in the cookies is the same as the generated one, the user is authorized.
    const jwtToken = req.cookies.jwtToken;
    const decoded = verifyToken(jwtToken);
    if (!decoded){
      return res.status(401).send({ error: 'Unauthorized' });
    }

    const username = decoded.username;

    // Make sure that user exists and connect the post to the userID.
    const sql = `
    INSERT INTO post(content, user)
    SELECT ?, (SELECT userId FROM user WHERE username = ?)
    WHERE EXISTS(SELECT userId FROM user WHERE username = ?)
    RETURNING *
    `;

    // Prepares the SQL statement.
    const stmt = db.prepare(sql);

    // Binds the parameters to the prepared statement.
    stmt.bind(content, username, username);

    // Executes the prepared statement and returns the result.
    stmt.get(function(err, result) {
      if (err) {
        console.error(err.message);
        res.status(500).json({"error": "Internal Server Error."});
      } else if (this.changes === 0) {
        res.status(400).send('User with specified ID does not exist');
      } else {
        res.status(201).send(result);
      }
    });

    stmt.finalize();
  });

  //* POST
  /**
   * Likes the specified post.
   */
  app.post('/api/posts/like/:postId', (req, res) => {
    const postId = req.params.postId,
    user = req.body.user;

    // Check if csrf-token match.
    const csrfToken = req.cookies.csrfToken;
    if (req.headers['x-csrf-token'] !== csrfToken) {
      return res.status(403).send({ error: 'CSRF token mismatch' });
    }

    // If the jwtToken in the cookies is the same as the generated one, the user is authorized.
    const jwtToken = req.cookies.jwtToken;
    const decoded = verifyToken(jwtToken);
    if (!decoded){
      return res.status(401).send({ error: 'Unauthorized' });
    }

    const insertLikedQuery = 'INSERT INTO like (post, user) VALUES (?, ?)';
    const stmtInsert = db.prepare(insertLikedQuery);

    stmtInsert.bind(postId, user);

    stmtInsert.run(function(err) {
      if (err) {
        // If there was an error (unique constraint, it is already in the db), unlike the post.
        const deleteQuery =
        'DELETE FROM like WHERE user = ? AND post = ?';
        const stmtDelete = db.prepare(deleteQuery);
        stmtDelete.bind(user, postId);
        stmtDelete.run(function(err){
          if (err) {
            console.error(err.message);
            res.status(500).json({"error": "Internal Server Error."});
          } else {
            res.status(201).send();
          }
        });
        stmtDelete.finalize();
      } else {
        // Success
        // If the user has disliked the post earlier, make sure to delete it from that table.
        // #TODO FIND ANOTHER WAY SO AN ERROR IS NOT SENT????
        const deleteQuery =
        'DELETE FROM dislike WHERE user = ? AND post = ?';
        const stmtDelete = db.prepare(deleteQuery);
        stmtDelete.bind(user, postId);
        stmtDelete.run(function(err){
          if (err) {
            console.error(err.message);
            //res.status(500).json({"error": "User had not disliked the post."});
          } else {
            res.status(201).send();
          }
        });
        stmtDelete.finalize();
        res.sendStatus(200);
      }
    })

    stmtInsert.finalize();
  });

  //* POST
  /**
   * Dislikes the specified post.
   */
  app.post('/api/posts/dislike/:postId', (req, res) => {

    const postId = req.params.postId,
    user = req.body.user;

    // Check if csrf-token match.
    const csrfToken = req.cookies.csrfToken;
    if (req.headers['x-csrf-token'] !== csrfToken) {
      return res.status(403).send({ error: 'CSRF token mismatch' });
    }

    // If the jwtToken in the cookies is the same as the generated one, the user is authorized.
    const jwtToken = req.cookies.jwtToken;
    const decoded = verifyToken(jwtToken);
    if (!decoded){
      return res.status(401).send({ error: 'Unauthorized' });
    }

    const insertLikedQuery = 'INSERT INTO dislike (post, user) VALUES (?, ?)';

    const stmtInsert = db.prepare(insertLikedQuery);
    stmtInsert.bind(postId, user);

    stmtInsert.run(function(err) {
      if (err) {
        const deleteQuery =
        'DELETE FROM dislike WHERE user = ? AND post = ?';
        const stmtDelete = db.prepare(deleteQuery);
        stmtDelete.bind(user, postId);
        stmtDelete.run(function(err){
          if (err) {
            console.error(err.message);
            res.status(500).json({"error": "Internal Server Error."});
          } else {
            res.status(201).send();
          }
        });
        stmtDelete.finalize();
      } else {
        // Success
        // If the user has liked the post earlier, make sure to delete it from that table.
        const deleteQuery =
        'DELETE FROM like WHERE user = ? AND post = ?';
        const stmtDelete = db.prepare(deleteQuery);
        stmtDelete.bind(user, postId);
        stmtDelete.run(function(err){
          if (err) {
            console.error(err.message);
            //res.status(500).json({"error": "User had not liked the post."});
          } else {
            res.status(201).send();
          }
        });
        stmtDelete.finalize();
        res.sendStatus(200);
      }
    })

    stmtInsert.finalize();
  });

  //* PATCH
  /**
   * Updates the specified post.
   */
  app.patch('/api/posts/:postId', limiter, (req, res) => {
    const postId = req.params.postId;
    // const user = req.body.user;  // userID
    // const content = req.body.content;

    // Validate post input.
    const validationResult = postSchema.validate(req.body);
    if (validationResult.error) {
      return res.status(400).json({error: validationResult.error.details[0].message});
    }

    // Get validated fields from Joi.
    const { user, content } = validationResult.value;

    // Check if csrf-token match.
    const csrfToken = req.cookies.csrfToken;
    if (req.headers['x-csrf-token'] !== csrfToken) {
      return res.status(403).send({ error: 'CSRF token mismatch' });
    }

    // If the jwtToken in the cookies is the same as the generated one, the user is authorized.
    const jwtToken = req.cookies.jwtToken;
    const decoded = verifyToken(jwtToken);
    if (!decoded){
      return res.status(401).send({ error: 'Unauthorized' });
    }

    // The SQL query to update the specified post.
    const sql = 'UPDATE post SET content = ? WHERE postId = ? AND user = ?';

    // Prepares the SQL statement.
    const stmt = db.prepare(sql);

    // Binds the parameters to the prepared statement.
    stmt.bind(content, postId, user);

    // Executes the prepared statement and returns the result.
    stmt.run(function(err) {
      if (err) {
        console.error(err.message);
        res.status(500).json({"error": "Internal Server Error."});
      } else if (this.changes === 0) {
        res.status(404).send('Post with specified ID not found');
      } else {
        res.status(200).send();
      }
    });

    // Finalizes the prepared statement to release its resources.
    stmt.finalize();
  });

  //* DELETE
  /**
   * Deletes the specified post.
   */
  app.delete('/api/posts/:id', limiter, (req, res) => {
    const postId = req.params.id,
    userId = Number(req.cookies.userid);

    // Check if csrf-token match.
    const csrfToken = req.cookies.csrfToken;
    if (req.headers['x-csrf-token'] !== csrfToken) {
      return res.status(403).send({ error: 'CSRF token mismatch' });
    }

    // If the jwtToken in the cookies is the same as the generated one, the user is authorized.
    const jwtToken = req.cookies.jwtToken;
    const decoded = verifyToken(jwtToken);
    if (!decoded){
      return res.status(401).send({ error: 'Unauthorized' });
    }

    const userSql = 'SELECT user FROM post WHERE postId = ?'
    const userStmt = db.prepare(userSql);
    userStmt.bind(postId);

    userStmt.get((err, row) => {
      if (err) {
        console.error(err.message);
        res.status(500).json({"error": "Internal Server Error."});
      } else {
        const user = row.user;
        // if the user is not admin, nor the owner of the post, return.
        if (userId !== user && decoded.username !== 'admin'){
          return res.status(401).send({ error: 'Unauthorized' });
        }

        // The SQL query to delete the specified post.
        const sql = 'DELETE FROM post WHERE postId = ?';

        // Prepares the SQL statement.
        const stmt = db.prepare(sql);

        // Binds the parameters to the prepared statement.
        stmt.bind(postId);

        // Executes the prepared statement and returns the result.
        stmt.run(function(err) {
          if (err) {
            console.error(err.message);
            res.status(500).json({"error": "Internal Server Error."});
          } else {
            res.status(204).send({id: this.lastID});
          }
        });

        // Finalizes the prepared statement to release its resources.
        stmt.finalize();
        }
      })
    userStmt.finalize();
  });

  /**
   * Deletes the specified like.
   */
  app.delete('/api/posts/like/:postId', (req, res) => {
    const postId = req.params.postId,
    user = req.body.user;

    // Check if csrf-token match.
    const csrfToken = req.cookies.csrfToken;
    if (req.headers['x-csrf-token'] !== csrfToken) {
      return res.status(403).send({ error: 'CSRF token mismatch' });
    }

    // If the jwtToken in the cookies is the same as the generated one, the user is authorized.
    const jwtToken = req.cookies.jwtToken;
    const decoded = verifyToken(jwtToken);
    if (!decoded){
      return res.status(401).send({ error: 'Unauthorized' });
    }

    // Make sure that user and post exists.
    const sql = `
    DELETE FROM like
    WHERE user = ? AND post = ?
    AND EXISTS(SELECT userId FROM user WHERE userId = ?)
    AND EXISTS(SELECT postId FROM post WHERE postId = ?)
    `;

    const stmt = db.prepare(sql);

    stmt.bind(user, postId, user, postId);

    stmt.run(function(err) {
      if (err) {
        console.error(err.message);
        res.status(500).json({"error": "Internal Server Error."});
      } else if (this.changes === 0) {
        res.status(404).send('Like with specified user and post not found');
      } else {
        res.status(204).send('Like deleted successfully');
      }
    });

    // Finalizes the prepared statement to release its resources.
    stmt.finalize();
  });

  /**
   * Deletes the specified dislike.
   */
  app.delete('/api/posts/dislike/:postId', (req, res) => {
    const postId = req.params.postId,
    user = req.body.user;

    // Check if csrf-token match.
    const csrfToken = req.cookies.csrfToken;
    if (req.headers['x-csrf-token'] !== csrfToken) {
      return res.status(403).send({ error: 'CSRF token mismatch' });
    }

    // If the jwtToken in the cookies is the same as the generated one, the user is authorized.
    const jwtToken = req.cookies.jwtToken;
    const decoded = verifyToken(jwtToken);
    if (!decoded){
      return res.status(401).send({ error: 'Unauthorized' });
    }

    // Make sure that user and post exists.
    const sql = `DELETE FROM dislike
    WHERE user = ? AND post = ?
    AND EXISTS(SELECT userId FROM user WHERE userId = ?)
    AND EXISTS(SELECT postId FROM post WHERE postId = ?)
    `;

    // Prepares the SQL statement.
    const stmt = db.prepare(sql);

    // Binds the parameters to the prepared statement.
    stmt.bind(postId, user);

    // Executes the prepared statement and returns the result.
    stmt.run(function(err) {
      if (err) {
        console.error(err.message);
        res.status(500).json({"error": "Internal Server Error."});
      } else if (this.changes === 0) {
        res.status(404).send('Dislike with specified user and post not found');
      } else {
        res.status(204).send('Like deleted successfully');
      }
    });

    // Finalizes the prepared statement to release its resources.
    stmt.finalize();
  });

  // Middleware function to check if the user is authenticated.
  function requireAuth(req, res, next) {
    const sessionId = req.cookies.ID; // Assuming the session ID is stored in a cookie called "ID".

    if (sessionId && sessionIds.hasValue(sessionId)) {
      // The user is authenticated. Allow the request to continue.
      next();
    } else {
      // The user is not authenticated. Return a 401 Unauthorized response.
      res.status(401).json({ error: 'Unauthorized.' });
    }
  }
}
