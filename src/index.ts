import express, { Request, Response } from 'express'
import { Pool } from 'pg'
import * as dotenv from 'dotenv'
import { ChromaClient, Collection, IEmbeddingFunction } from 'chromadb'
import { OpenAI } from 'openai'
import { Chunk } from './types'

dotenv.config()

if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY in .env')
if (!process.env.DATABASE_URL) throw new Error('Missing DATABASE_URL in .env')
if (!process.env.CHROMADB_HOST) throw new Error('Missing CHROMADB_HOST in .env')

const app: express.Application = express()
app.use(express.json())

const pool: Pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function setupDatabase(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS stored_texts (
            id SERIAL PRIMARY KEY,
            text TEXT UNIQUE NOT NULL
        );
        CREATE INDEX IF NOT EXISTS stored_texts_text_index ON stored_texts (text);
    `)
    console.log('Database schema and index ensured.')
}

setupDatabase()

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const chroma: ChromaClient = new ChromaClient({ path: process.env.CHROMADB_HOST })
let collection: Collection

const dummyEmbeddingFunction: IEmbeddingFunction = {
    generate: async (texts: string[]): Promise<number[][]> => texts.map(() => [])
}

async function setupChroma(): Promise<void> {
    console.log('Ensuring ChromaDB collection exists...')
    collection = await chroma.getOrCreateCollection({
        name: 'text_embeddings',
        embeddingFunction: dummyEmbeddingFunction,
    })
    console.log('ChromaDB collection ready:', collection.name)
}

setupChroma()

async function generateEmbedding(text: string): Promise<number[]> {
    const response = await openai.embeddings.create({
        model: 'text-embedding-3-large',
        input: text,
    })
    return response.data[0].embedding
}

app.post('/chunks', async (req: Request, res: Response): Promise<void> => {
    const chunks: Chunk[] = req.body

    if (!Array.isArray(chunks) || chunks.length === 0) {
        res.status(400).json({ error: 'Array of chunks is required' })
        return
    }

    try {
        for (const {text, url, index} of chunks) {
            const embedding = await generateEmbedding(text)
            const id = `${url}_${index}`

            await collection.add({
                ids: [id],
                embeddings: [embedding],
                metadatas: [{text, url, index}],
            })
            console.log(`Successfully added chunk: ${id}`)

            await pool.query(
                `INSERT INTO stored_texts (text) VALUES ($1) 
                ON CONFLICT (text) DO NOTHING;`,
                [text]
            )
        }

        res.json({message: 'Chunks stored successfully'})
    } catch (err) {
        const error = err as Error
        res.status(500).json({error: error.message})
    }
})

app.get('/chunks', async (req: Request, res: Response): Promise<void> => {
    const url = req.query.url as string
    const index = parseInt(req.query.index as string, 10)

    if (!url || isNaN(index)) {
        res.status(400).json({error: 'Valid url and index are required'})
        return
    }

    try {
        const query = `
            SELECT text, url, index
            FROM stored_texts
            WHERE url = $1 AND index BETWEEN $2 AND $3
            ORDER BY index;
        `
        const {rows} = await pool.query(query, [url, index - 2, index + 2])

        res.json({chunks: rows})
    } catch (err) {
        const error = err as Error
        res.status(500).json({ error: error.message })
    }
})

app.get('/search', async (req: Request, res: Response): Promise<void> => {
    const query = req.query.query as string
    const limit = parseInt(req.query.limit as string, 10) || 10
    const searchSize = parseInt(req.query.searchSize as string, 10) || 100
    const bm25Weight = parseFloat(req.query.bm25Weight as string) || 0.4

    if (!query) {
        res.status(400).json({ error: 'Query is required' })
        return
    }

    try {
        const queryEmbedding = await generateEmbedding(query)
        const vectorResults = await collection.query({
            queryEmbeddings: [queryEmbedding],
            nResults: searchSize,
        })
        const bm25Query = `
            SELECT text, ts_rank_cd(to_tsvector(text), plainto_tsquery($1)) AS score
            FROM stored_texts
            WHERE to_tsvector(text) @@ plainto_tsquery($1)
            ORDER BY score DESC
            LIMIT $2;
        `
        const {rows} = await pool.query(bm25Query, [query, searchSize])
        const bm25Results = rows.map(row => ({
            text: row.text,
            score: row.score
        }))
        const hybridResults = mergeAndRank(vectorResults, bm25Results, bm25Weight).slice(0, limit)

        res.json({ results: hybridResults })
    } catch (err) {
        const error = err as Error
        res.status(500).json({error: error.message})
    }
})

function mergeAndRank(vectorResults: any, bm25Results: any, bm25Weight: number) {
    const combined: Record<string, {text: string; score: number}> = {}

    if (vectorResults.ids.length > 0) {
        vectorResults.ids[0].forEach((id: string, index: number) => {
            const similarityScore = vectorResults.distances[0][index] || 1
            combined[id] = {text: vectorResults.metadatas[0][index].text, score: 1 - similarityScore}
        })
    }

    bm25Results.forEach(({text, score}: {text: string; score: number}) => {
        if (combined[text]) {
            combined[text].score += score * bm25Weight
        } else {
            combined[text] = { text, score: score * bm25Weight }
        }
    })

    return Object.values(combined).sort((a, b) => b.score - a.score)
}

const PORT: number = Number(process.env.PORT) || 3000
app.listen(PORT, (): void => console.log(`Server running on port ${PORT}`))
