
// ============================================================
//  Sistema de Exámenes v2 — Variantes A/B/C/D
//  Login por ID + Variante + Contraseña
//  Optimizado para Railway
// ============================================================
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;
const DATA_DIR = IS_PROD ? '/app/data' : path.join(__dirname, 'data');
const UPLOADS_DIR = IS_PROD ? '/app/data/uploads' : path.join(__dirname, 'uploads');
const BASE_FILES_DIR = path.join(UPLOADS_DIR, 'base-files');
const STUDENT_FILES_DIR = path.join(UPLOADS_DIR, 'student-files');
const DB_PATH = path.join(DATA_DIR, 'examenes_v2.db');

[DATA_DIR, UPLOADS_DIR, BASE_FILES_DIR, STUDENT_FILES_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, req.path.includes('student') ? STUDENT_FILES_DIR : BASE_FILES_DIR);
  },
  filename: (req, file, cb) => {
    const u = Date.now() + '-' + Math.round(Math.random() * 1E6);
    const e = path.extname(file.originalname);
    const n = path.basename(file.originalname, e).replace(/[^a-zA-Z0-9_.-]/g, '_');
    cb(null, u + '-' + n + e);
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

console.log('BD:', DB_PATH);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    name TEXT NOT NULL,
    subject TEXT DEFAULT 'Simulacion',
    variant TEXT NOT NULL DEFAULT 'A',
    password TEXT NOT NULL,
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
    exam_id INTEGER NOT NULL,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    file_size INTEGER,
    file_path TEXT NOT NULL,
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    student_code TEXT NOT NULL,
    status TEXT DEFAULT 'pendiente'
  );
  CREATE TABLE IF NOT EXISTS attempts (
    student_id INTEGER NOT NULL,
    exam_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    PRIMARY KEY (student_id, exam_id)
  );

  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    exam_id INTEGER NOT NULL,
    answers TEXT NOT NULL,
    results TEXT NOT NULL,
    total_earned REAL,
    final_grade REAL,
    time_used INTEGER,
    auto_submitted INTEGER DEFAULT 0,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(id),
    FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE CASCADE,
    UNIQUE(student_id, exam_id)
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

// === PAGINAS ===
app.get('/', (req, res) => res.redirect('/alumno'));
app.get('/profesor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'profesor.html')));
app.get('/alumno', (req, res) => res.sendFile(path.join(__dirname, 'public', 'alumno.html')));
app.get('/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', ts: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// === CREAR EXAMEN CON VARIANTES ===
app.post('/api/exams', upload.array('baseFiles'), (req, res) => {
  try {
    const { name, subject, tolerance, timeLimit, examDate, variants, studentCodes } = req.body;
    const parsedVariants = JSON.parse(variants);
    const parsedCodes = JSON.parse(studentCodes);
    const groupId = Date.now().toString();

    const examStmt = db.prepare('INSERT INTO exams (group_id,name,subject,variant,password,tolerance,time_limit,exam_date,problem_title,problem_description,questions,total_points) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    const fileStmt = db.prepare('INSERT INTO exam_files (exam_id,original_name,stored_name,file_size,file_path) VALUES (?,?,?,?,?)');

    const createdVariants = [];

    parsedVariants.forEach(v => {
      const totalPts = v.questions.reduce((s, q) => s + q.points, 0);
      const r = examStmt.run(groupId, name, subject || 'Simulacion', v.variant, v.password, parseFloat(tolerance) || 2, parseInt(timeLimit) || 60, examDate, v.problemTitle || '', v.problemDescription || '', JSON.stringify(v.questions), totalPts);
      const examId = r.lastInsertRowid;

      // Archivos: buscar los que corresponden a esta variante
      if (req.files) {
        req.files.forEach(f => {
          if (f.fieldname === 'baseFiles' && f.originalname.startsWith('VAR_' + v.variant + '_')) {
            const realName = f.originalname.replace('VAR_' + v.variant + '_', '');
            fileStmt.run(examId, realName, f.filename, f.size, f.path);
          } else if (f.fieldname === 'baseFiles' && f.originalname.startsWith('SHARED_')) {
            const realName = f.originalname.replace('SHARED_', '');
            fileStmt.run(examId, realName, f.filename, f.size, f.path);
          }
        });
      }

      createdVariants.push({ variant: v.variant, examId, password: v.password });
    });

    // Alumnos
    const stuStmt = db.prepare('INSERT INTO students (group_id,student_code) VALUES (?,?)');
    const insertedStudents = [];
    parsedCodes.forEach(code => {
      const r = stuStmt.run(groupId, code.trim());
      insertedStudents.push({ id: r.lastInsertRowid, code: code.trim() });
    });

    res.json({ success: true, groupId, variants: createdVariants, students: insertedStudents });
  } catch (e) {
    console.error('Error creando examen:', e);
    res.status(500).json({ error: e.message });
  }
});

// === OBTENER EXAMENES ===
app.get('/api/exams', (req, res) => {
  try {
    const groups = db.prepare('SELECT DISTINCT group_id, name, subject, tolerance, time_limit, exam_date, created_at FROM exams ORDER BY created_at DESC').all();
    const result = groups.map(g => {
      const variants = db.prepare('SELECT * FROM exams WHERE group_id = ?').all(g.group_id).map(ex => {
        const files = db.prepare('SELECT * FROM exam_files WHERE exam_id = ?').all(ex.id);
        return { ...ex, questions: JSON.parse(ex.questions), files };
      });
      const students = db.prepare('SELECT * FROM students WHERE group_id = ?').all(g.group_id).map(st => {
        const subs = db.prepare('SELECT sub.*, e.variant, e.name as exam_name FROM submissions sub JOIN exams e ON sub.exam_id=e.id WHERE sub.student_id=?').all(st.id).map(sub => ({
          ...sub, results: JSON.parse(sub.results),
          studentFiles: db.prepare('SELECT * FROM student_files WHERE submission_id=?').all(sub.id)
        }));
        return { ...st, submissions: subs };
      });
      return { ...g, variants, students };
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === VARIANTES DISPONIBLES PARA UN GRUPO (alumno ve cuales hay) ===
app.get('/api/variants/:groupId', (req, res) => {
  try {
    const rows = db.prepare('SELECT id, variant, name FROM exams WHERE group_id = ?').all(req.params.groupId);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === OBTENER GRUPOS ACTIVOS (para alumno) ===
app.get('/api/active-groups', (req, res) => {
  try {
    const rows = db.prepare('SELECT DISTINCT group_id, name, subject FROM exams ORDER BY created_at DESC').all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === LOGIN ALUMNO: ID + variante + password ===
app.post('/api/student/login', (req, res) => {
  try {
    const { studentCode, groupId, variant, password } = req.body;
    if (!studentCode || !groupId || !variant || !password) {
      return res.status(400).json({ error: 'Todos los campos son requeridos.' });
    }

    const student = db.prepare('SELECT * FROM students WHERE LOWER(TRIM(student_code))=LOWER(TRIM(?)) AND group_id=?').get(studentCode.trim(), groupId);
    if (!student) return res.status(401).json({ error: 'Tu ID no esta registrado en este examen.' });

    const exam = db.prepare('SELECT * FROM exams WHERE group_id=? AND variant=?').get(groupId, variant);
    if (!exam) return res.status(404).json({ error: 'Variante no encontrada.' });
    if (exam.password !== password.trim()) return res.status(401).json({ error: 'Contrasena incorrecta para la variante ' + variant + '.' });

    const existingSub = db.prepare('SELECT id FROM submissions WHERE student_id=? AND exam_id=?').get(student.id, exam.id);
    if (existingSub) return res.status(403).json({ error: 'Ya enviaste este examen (variante ' + variant + '). No puedes entrar de nuevo.' });

    // Hora de inicio en el servidor: sobrevive a recargas y cierres del navegador
    db.prepare('INSERT OR IGNORE INTO attempts (student_id,exam_id,started_at) VALUES (?,?,?)').run(student.id, exam.id, Date.now());
    const attempt = db.prepare('SELECT started_at FROM attempts WHERE student_id=? AND exam_id=?').get(student.id, exam.id);
    const remainingSeconds = Math.max(0, Math.floor(exam.time_limit * 60 - (Date.now() - attempt.started_at) / 1000));

    const files = db.prepare('SELECT id,original_name,stored_name,file_size FROM exam_files WHERE exam_id=?').all(exam.id);

    res.json({
      studentId: student.id,
      examId: exam.id,
      studentCode: student.student_code,
      examName: exam.name,
      subject: exam.subject,
      variant: exam.variant,
      tolerance: exam.tolerance,
      timeLimit: exam.time_limit,
      remainingSeconds,
      problemTitle: exam.problem_title,
      problemDescription: exam.problem_description,
      questions: JSON.parse(exam.questions),
      totalPoints: exam.total_points,
      baseFiles: files
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === DESCARGAR ARCHIVO BASE ===
app.get('/api/files/base/:id', (req, res) => {
  try {
    const file = db.prepare('SELECT * FROM exam_files WHERE id=?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'Archivo no encontrado.' });
    if (!fs.existsSync(file.file_path)) return res.status(404).json({ error: 'Archivo no existe en disco.' });
    res.download(file.file_path, file.original_name);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === ENVIAR EXAMEN ===
app.post('/api/student/submit', upload.array('studentFiles'), (req, res) => {
  try {
    const { studentId, examId, answers, timeUsed, autoSubmitted } = req.body;
    const parsedAnswers = JSON.parse(answers);
    const exam = db.prepare('SELECT * FROM exams WHERE id=?').get(parseInt(examId));
    if (!exam) return res.status(404).json({ error: 'Examen no encontrado.' });

    const existing = db.prepare('SELECT id FROM submissions WHERE student_id=? AND exam_id=?').get(parseInt(studentId), parseInt(examId));
    if (existing) return res.status(403).json({ error: 'Ya enviaste este examen.' });

    const questions = JSON.parse(exam.questions);
    let totalEarned = 0;

    const results = questions.map((q, i) => {
      const sa = parsedAnswers[i];
      let correct = false;
      let displayAnswer = (sa !== null && sa !== undefined && sa !== '') ? String(sa) : 'Sin respuesta';

      if (q.type === 'numerica') {
        const num = parseFloat(sa);
        if (!isNaN(num)) {
          correct = q.answer === 0 ? num === 0 : Math.abs((num - q.answer) / q.answer) * 100 <= exam.tolerance;
          displayAnswer = String(num);
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
        studentAnswer: displayAnswer, points: q.points, earned, correct
      };
    });

    const finalGrade = exam.total_points > 0 ? (totalEarned / exam.total_points) * 100 : 0;
    const subR = db.prepare('INSERT INTO submissions (student_id,exam_id,answers,results,total_earned,final_grade,time_used,auto_submitted) VALUES (?,?,?,?,?,?,?,?)').run(
      parseInt(studentId), parseInt(examId), JSON.stringify(parsedAnswers), JSON.stringify(results), totalEarned, finalGrade, parseInt(timeUsed) || 0, autoSubmitted === 'true' || autoSubmitted === true ? 1 : 0
    );
    const subId = subR.lastInsertRowid;

    if (req.files && req.files.length > 0) {
      const sfStmt = db.prepare('INSERT INTO student_files (submission_id,student_id,original_name,stored_name,file_size,file_path) VALUES (?,?,?,?,?,?)');
      req.files.forEach(f => sfStmt.run(subId, parseInt(studentId), f.originalname, f.filename, f.size, f.path));
    }

    db.prepare("UPDATE students SET status='enviado' WHERE id=?").run(parseInt(studentId));
    console.log('Examen enviado: #' + studentId + ' var ' + exam.variant + ' -> ' + finalGrade.toFixed(1) + '%');
    res.json({ success: true, finalGrade: finalGrade.toFixed(1), totalEarned, results });
  } catch (e) {
    console.error('Error submit:', e);
    res.status(500).json({ error: e.message });
  }
});

// === CALIFICACIONES ===
app.get('/api/grades', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT s.id as student_id, s.student_code, s.status, s.group_id,
             e.id as exam_id, e.name as exam_name, e.variant, e.total_points, e.time_limit,
             sub.final_grade, sub.total_earned, sub.time_used, sub.auto_submitted,
             sub.submitted_at, sub.results, sub.id as submission_id
      FROM students s
      LEFT JOIN submissions sub ON sub.student_id = s.id
      LEFT JOIN exams e ON sub.exam_id = e.id
      ORDER BY s.group_id DESC, s.student_code
    `).all();

    const grades = rows.map(r => ({
      ...r,
      results: r.results ? JSON.parse(r.results) : null,
      studentFiles: r.submission_id ? db.prepare('SELECT * FROM student_files WHERE submission_id=?').all(r.submission_id) : []
    }));
    res.json(grades);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === REPORTE INDIVIDUAL ===
app.get('/api/report/:studentId/:examId', (req, res) => {
  try {
    const row = db.prepare(`
      SELECT s.student_code, e.name as exam_name, e.subject, e.variant, e.tolerance,
             e.time_limit, e.total_points, e.problem_title, e.problem_description,
             sub.final_grade, sub.total_earned, sub.time_used, sub.auto_submitted,
             sub.submitted_at, sub.results, sub.id as submission_id
      FROM students s
      JOIN submissions sub ON sub.student_id = s.id
      JOIN exams e ON sub.exam_id = e.id
      WHERE s.id=? AND e.id=?
    `).get(req.params.studentId, req.params.examId);

    if (!row) return res.status(404).json({ error: 'No encontrado.' });
    row.results = JSON.parse(row.results);
    row.studentFiles = db.prepare('SELECT * FROM student_files WHERE submission_id=?').all(row.submission_id);
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === DESCARGAR ARCHIVO ALUMNO ===
app.get('/api/files/student/:id', (req, res) => {
  try {
    const file = db.prepare('SELECT * FROM student_files WHERE id=?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'No encontrado.' });
    if (!fs.existsSync(file.file_path)) return res.status(404).json({ error: 'No existe.' });
    res.download(file.file_path, file.original_name);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === ELIMINAR GRUPO ===
app.delete('/api/exams/:groupId', (req, res) => {
  try {
    const gid = req.params.groupId;
    const exams = db.prepare('SELECT id FROM exams WHERE group_id=?').all(gid);
    db.transaction(() => {
      exams.forEach(ex => {
        const sf = db.prepare('SELECT sf.file_path FROM student_files sf JOIN submissions sub ON sf.submission_id=sub.id WHERE sub.exam_id=?').all(ex.id);
        sf.forEach(f => { try { if (fs.existsSync(f.file_path)) fs.unlinkSync(f.file_path); } catch (e) {} });
        const ef = db.prepare('SELECT file_path FROM exam_files WHERE exam_id=?').all(ex.id);
        ef.forEach(f => { try { if (fs.existsSync(f.file_path)) fs.unlinkSync(f.file_path); } catch (e) {} });
        db.prepare('DELETE FROM student_files WHERE submission_id IN (SELECT id FROM submissions WHERE exam_id=?)').run(ex.id);
        db.prepare('DELETE FROM submissions WHERE exam_id=?').run(ex.id);
        db.prepare('DELETE FROM exam_files WHERE exam_id=?').run(ex.id);
        db.prepare('DELETE FROM exams WHERE id=?').run(ex.id);
      });
      db.prepare('DELETE FROM students WHERE group_id=?').run(gid);
    })();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === SHUTDOWN ===
process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT', () => { db.close(); process.exit(0); });

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n Sistema de Examenes v2 - Variantes A/B/C/D');
  console.log(' Puerto: ' + PORT);
  console.log(' Entorno: ' + (IS_PROD ? 'PRODUCCION' : 'LOCAL'));
  console.log(' Profesor: http://localhost:' + PORT + '/profesor');
  console.log(' Alumno:   http://localhost:' + PORT + '/alumno\n');
});

