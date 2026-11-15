
// ============================================================
//  Sistema de Exámenes — Simulación 2° Parcial
//  Optimizado para Railway (volúmenes persistentes + SQLite)
// ============================================================

const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();

// ===== Railway asigna el puerto dinámicamente =====
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;

// ===== RUTAS PERSISTENTES =====
const DATA_DIR = IS_PROD ? '/app/data' : path.join(__dirname, 'data');
const UPLOADS_DIR = IS_PROD ? '/app/uploads' : path.join(__dirname, 'uploads');
const BASE_FILES_DIR = path.join(UPLOADS_DIR, 'base-files');
const STUDENT_FILES_DIR = path.join(UPLOADS_DIR, 'student-files');
const DB_PATH = path.join(DATA_DIR, 'examenes.db');

// Crear directorios si no existen
[DATA_DIR, UPLOADS_DIR, BASE_FILES_DIR, STUDENT_FILES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ===== MIDDLEWARE =====
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ===== MULTER: acepta CUALQUIER tipo de archivo =====
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dest = req.path.includes('student') ? STUDENT_FILES_DIR : BASE_FILES_DIR;
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E6);
    const ext = path.extname(file.originalname);
    const name = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_.-]/g, '_');
    cb(null, unique + '-' + name + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

// ===== BASE DE DATOS SQLite =====
console.log('📁 Base de datos: ' + DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    subject TEXT DEFAULT 'Simulación',
    tolerance REAL DEFAULT 2,
    time_limit INTEGER DEFAULT 60,
    exam_date TEXT,
    problem_title TEXT,
    problem_description TEXT,
    questions TEXT NOT NULL,
    total_points REAL NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS exam_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    file_size INTEGER,
    file_path TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    password TEXT NOT NULL,
    status TEXT DEFAULT 'pendiente',
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL UNIQUE,
    exam_id INTEGER NOT NULL,
    answers TEXT NOT NULL,
    results TEXT NOT NULL,
    total_earned REAL,
    final_grade REAL,
    time_used INTEGER,
    auto_submitted INTEGER DEFAULT 0,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(id),
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS student_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    submission_id INTEGER NOT NULL,
    student_id INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    file_size INTEGER,
    file_path TEXT NOT NULL,
    FOREIGN KEY (submission_id) REFERENCES submissions(id),
    FOREIGN KEY (student_id) REFERENCES students(id)
  );
`);

// ===== RUTAS: PÁGINAS =====
app.get('/', (req, res) => res.redirect('/alumno'));
app.get('/profesor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profesor.html')));
app.get('/alumno', (req, res) => res.sendFile(path.join(__dirname, 'public', 'alumno.html')));

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', timestamp: new Date().toISOString(), exams: db.prepare('SELECT COUNT(*) as c FROM exams').get().c });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ===== API: CREAR EXAMEN =====
app.post('/api/exams', upload.array('baseFiles'), (req, res) => {
  try {
    const { name, subject, tolerance, timeLimit, examDate, problemTitle, problemDescription, questions, students } = req.body;
    const parsedQuestions = JSON.parse(questions);
    const parsedStudents = JSON.parse(students);
    const totalPoints = parsedQuestions.reduce((s, q) => s + q.points, 0);
    const groupId = Date.now().toString();

    const examStmt = db.prepare('INSERT INTO exams (group_id, name, subject, tolerance, time_limit, exam_date, problem_title, problem_description, questions, total_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const examResult = examStmt.run(groupId, name, subject || 'Simulación', parseFloat(tolerance) || 2, parseInt(timeLimit) || 60, examDate, problemTitle, problemDescription, JSON.stringify(parsedQuestions), totalPoints);
    const examId = examResult.lastInsertRowid;

    if (req.files && req.files.length > 0) {
      const fileStmt = db.prepare('INSERT INTO exam_files (group_id, original_name, stored_name, file_size, file_path) VALUES (?, ?, ?, ?, ?)');
      req.files.forEach(f => {
        fileStmt.run(groupId, f.originalname, f.filename, f.size, f.path);
      });
    }

    const studentStmt = db.prepare('INSERT INTO students (exam_id, name, password) VALUES (?, ?, ?)');
    const insertedStudents = [];
    parsedStudents.forEach(s => {
      const r = studentStmt.run(examId, s.name, s.password);
      insertedStudents.push({ id: r.lastInsertRowid, name: s.name, password: s.password });
    });

    res.json({ success: true, examId, groupId, students: insertedStudents });
  } catch (err) {
    console.error('Error creando examen:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== API: OBTENER TODOS LOS EXÁMENES =====
app.get('/api/exams', (req, res) => {
  try {
    const allExams = db.prepare('SELECT * FROM exams ORDER BY created_at DESC').all();
    const result = allExams.map(exam => {
      const students = db.prepare('SELECT * FROM students WHERE exam_id = ?').all(exam.id);
      const files = db.prepare('SELECT * FROM exam_files WHERE group_id = ?').all(exam.group_id);
      const studentsWithSubs = students.map(st => {
        const sub = db.prepare('SELECT * FROM submissions WHERE student_id = ?').get(st.id);
        const stFiles = sub ? db.prepare('SELECT * FROM student_files WHERE submission_id = ?').all(sub.id) : [];
        return { ...st, submission: sub ? { ...sub, results: JSON.parse(sub.results), studentFiles: stFiles } : null };
      });
      return { ...exam, questions: JSON.parse(exam.questions), students: studentsWithSubs, baseFiles: files };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== API: LOGIN ALUMNO =====
app.post('/api/student/login', (req, res) => {
  try {
    const { name, password } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'Nombre y contraseña requeridos.' });

    const student = db.prepare(`
      SELECT s.*, e.name as exam_name, e.subject, e.tolerance, e.time_limit,
             e.problem_title, e.problem_description, e.questions, e.total_points, e.group_id
      FROM students s
      JOIN exams e ON s.exam_id = e.id
      WHERE LOWER(TRIM(s.name)) = LOWER(TRIM(?)) AND s.password = ?
    `).get(name.trim(), password.trim());

    if (!student) return res.status(401).json({ error: 'Nombre o contraseña incorrectos.' });

    const sub = db.prepare('SELECT id FROM submissions WHERE student_id = ?').get(student.id);
    if (sub) return res.status(403).json({ error: 'Ya enviaste este examen. No puedes entrar de nuevo.' });

    const files = db.prepare('SELECT id, original_name, stored_name, file_size FROM exam_files WHERE group_id = ?').all(student.group_id);

    res.json({
      studentId: student.id,
      examId: student.exam_id,
      studentName: student.name,
      examName: student.exam_name,
      subject: student.subject,
      tolerance: student.tolerance,
      timeLimit: student.time_limit,
      problemTitle: student.problem_title,
      problemDescription: student.problem_description,
      questions: JSON.parse(student.questions),
      totalPoints: student.total_points,
      baseFiles: files
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== API: DESCARGAR ARCHIVO BASE =====
app.get('/api/files/base/:id', (req, res) => {
  try {
    const file = db.prepare('SELECT * FROM exam_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'Archivo no encontrado.' });
    if (!fs.existsSync(file.file_path)) return res.status(404).json({ error: 'Archivo no existe en disco.' });
    res.download(file.file_path, file.original_name);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== API: ENVIAR EXAMEN =====
app.post('/api/student/submit', upload.array('studentFiles'), (req, res) => {
  try {
    const { studentId, examId, answers, timeUsed, autoSubmitted } = req.body;
    const parsedAnswers = JSON.parse(answers);

    const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(parseInt(examId));
    if (!exam) return res.status(404).json({ error: 'Examen no encontrado.' });

    const existing = db.prepare('SELECT id FROM submissions WHERE student_id = ?').get(parseInt(studentId));
    if (existing) return res.status(403).json({ error: 'Ya enviaste este examen.' });

    const questions = JSON.parse(exam.questions);
    let totalEarned = 0;

    const results = questions.map((q, i) => {
      const sa = parsedAnswers[i];
      let correct = false;
      let displayAnswer = (sa !== null && sa !== undefined && sa !== '') ? String(sa) : 'Sin respuesta';

      if (q.type === 'numerica') {
        const numAnswer = parseFloat(sa);
        if (!isNaN(numAnswer)) {
          if (q.answer === 0) { correct = numAnswer === 0; }
          else { correct = Math.abs((numAnswer - q.answer) / q.answer) * 100 <= exam.tolerance; }
          displayAnswer = String(numAnswer);
        }
      } else if (q.type === 'multiple') {
        correct = sa === q.answer;
        displayAnswer = sa ? sa + '. ' + (q.options[sa] || '') : 'Sin respuesta';
      } else if (q.type === 'vf') {
        correct = sa === q.answer;
      }

      const earned = correct ? q.points : 0;
      totalEarned += earned;

      return {
        num: q.num, type: q.type, text: q.text,
        correctAnswer: q.type === 'multiple' ? q.answer + '. ' + (q.options[q.answer] || '') : String(q.answer),
        studentAnswer: displayAnswer,
        points: q.points, earned, correct
      };
    });

    const finalGrade = exam.total_points > 0 ? (totalEarned / exam.total_points) * 100 : 0;

    const subStmt = db.prepare('INSERT INTO submissions (student_id, exam_id, answers, results, total_earned, final_grade, time_used, auto_submitted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const subResult = subStmt.run(
      parseInt(studentId), parseInt(examId),
      JSON.stringify(parsedAnswers), JSON.stringify(results),
      totalEarned, finalGrade,
      parseInt(timeUsed) || 0,
      autoSubmitted === 'true' || autoSubmitted === true ? 1 : 0
    );
    const submissionId = subResult.lastInsertRowid;

    if (req.files && req.files.length > 0) {
      const sfStmt = db.prepare('INSERT INTO student_files (submission_id, student_id, original_name, stored_name, file_size, file_path) VALUES (?, ?, ?, ?, ?, ?)');
      req.files.forEach(f => {
        sfStmt.run(submissionId, parseInt(studentId), f.originalname, f.filename, f.size, f.path);
      });
    }

    db.prepare("UPDATE students SET status = 'enviado' WHERE id = ?").run(parseInt(studentId));

    console.log('✅ Examen enviado: Alumno #' + studentId + ' → ' + finalGrade.toFixed(1) + '%');
    res.json({ success: true, finalGrade: finalGrade.toFixed(1), totalEarned, results });
  } catch (err) {
    console.error('Error al enviar examen:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== API: CALIFICACIONES =====
app.get('/api/grades', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT s.id as student_id, s.name as student_name, s.status, s.password,
             e.id as exam_id, e.name as exam_name, e.total_points, e.time_limit,
             sub.final_grade, sub.total_earned, sub.time_used, sub.auto_submitted,
             sub.submitted_at, sub.results, sub.id as submission_id
      FROM students s
      JOIN exams e ON s.exam_id = e.id
      LEFT JOIN submissions sub ON sub.student_id = s.id
      ORDER BY e.name, s.name
    `).all();

    const grades = rows.map(r => ({
      ...r,
      results: r.results ? JSON.parse(r.results) : null,
      studentFiles: r.submission_id
        ? db.prepare('SELECT * FROM student_files WHERE submission_id = ?').all(r.submission_id)
        : []
    }));

    res.json(grades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== API: REPORTE INDIVIDUAL =====
app.get('/api/report/:studentId', (req, res) => {
  try {
    const row = db.prepare(`
      SELECT s.name as student_name,
             e.name as exam_name, e.subject, e.tolerance, e.time_limit, e.total_points,
             e.problem_title, e.problem_description,
             sub.final_grade, sub.total_earned, sub.time_used, sub.auto_submitted,
             sub.submitted_at, sub.results, sub.id as submission_id
      FROM students s
      JOIN exams e ON s.exam_id = e.id
      JOIN submissions sub ON sub.student_id = s.id
      WHERE s.id = ?
    `).get(req.params.studentId);

    if (!row) return res.status(404).json({ error: 'No encontrado.' });

    row.results = JSON.parse(row.results);
    row.studentFiles = db.prepare('SELECT * FROM student_files WHERE submission_id = ?').all(row.submission_id);

    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== API: DESCARGAR ARCHIVO DEL ALUMNO =====
app.get('/api/files/student/:id', (req, res) => {
  try {
    const file = db.prepare('SELECT * FROM student_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'Archivo no encontrado.' });
    if (!fs.existsSync(file.file_path)) return res.status(404).json({ error: 'Archivo no existe en disco.' });
    res.download(file.file_path, file.original_name);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== API: ELIMINAR GRUPO DE EXAMEN =====
app.delete('/api/exams/:groupId', (req, res) => {
  try {
    const examsToDelete = db.prepare('SELECT id FROM exams WHERE group_id = ?').all(req.params.groupId);

    const deleteTransaction = db.transaction(() => {
      examsToDelete.forEach(e => {
        const stFiles = db.prepare(`
          SELECT sf.file_path FROM student_files sf
          JOIN students s ON sf.student_id = s.id
          WHERE s.exam_id = ?
        `).all(e.id);
        stFiles.forEach(f => { try { if (fs.existsSync(f.file_path)) fs.unlinkSync(f.file_path); } catch(err) {} });

        db.prepare('DELETE FROM student_files WHERE student_id IN (SELECT id FROM students WHERE exam_id = ?)').run(e.id);
        db.prepare('DELETE FROM submissions WHERE exam_id = ?').run(e.id);
        db.prepare('DELETE FROM students WHERE exam_id = ?').run(e.id);
        db.prepare('DELETE FROM exams WHERE id = ?').run(e.id);
      });

      const baseFiles = db.prepare('SELECT file_path FROM exam_files WHERE group_id = ?').all(req.params.groupId);
      baseFiles.forEach(f => { try { if (fs.existsSync(f.file_path)) fs.unlinkSync(f.file_path); } catch(err) {} });
      db.prepare('DELETE FROM exam_files WHERE group_id = ?').run(req.params.groupId);
    });

    deleteTransaction();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== API: ELIMINAR ALUMNO INDIVIDUAL =====
app.delete('/api/students/:studentId', (req, res) => {
  try {
    const sid = parseInt(req.params.studentId);
    const sub = db.prepare('SELECT id FROM submissions WHERE student_id = ?').get(sid);
    if (sub) {
      const files = db.prepare('SELECT file_path FROM student_files WHERE submission_id = ?').all(sub.id);
      files.forEach(f => { try { if (fs.existsSync(f.file_path)) fs.unlinkSync(f.file_path); } catch(err) {} });
      db.prepare('DELETE FROM student_files WHERE submission_id = ?').run(sub.id);
      db.prepare('DELETE FROM submissions WHERE id = ?').run(sub.id);
    }
    db.prepare('DELETE FROM students WHERE id = ?').run(sid);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGTERM', () => {
  console.log('🔴 SIGTERM recibido. Cerrando...');
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🔴 SIGINT recibido. Cerrando...');
  db.close();
  process.exit(0);
});

// ===== INICIAR SERVIDOR =====
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🎓 ═══════════════════════════════════════════════');
  console.log('   Sistema de Exámenes — Simulación 2° Parcial');
  console.log('   ═══════════════════════════════════════════════');
  console.log('\n   🟢 Servidor corriendo en puerto ' + PORT);
  console.log('   🌍 Entorno: ' + (IS_PROD ? 'PRODUCCIÓN (Railway)' : 'LOCAL'));
  console.log('\n   👨‍🏫 Profesor: http://localhost:' + PORT + '/profesor');
  console.log('   🎓 Alumno:   http://localhost:' + PORT + '/alumno');
  console.log('   💚 Health:   http://localhost:' + PORT + '/health');
  console.log('\n   📁 BD: ' + DB_PATH);
  console.log('   📎 Archivos: ' + UPLOADS_DIR);
  console.log('\n   ═══════════════════════════════════════════════\n');
});

