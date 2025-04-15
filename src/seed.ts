import * as lancedb from "@lancedb/lancedb";
import minimist from 'minimist';
import {
  RecursiveCharacterTextSplitter
} from 'langchain/text_splitter';
import {
  DirectoryLoader
} from 'langchain/document_loaders/fs/directory';
import {
  LanceDB, LanceDBArgs
} from "@langchain/community/vectorstores/lancedb";
import { Document } from "@langchain/core/documents";
import { Ollama, OllamaEmbeddings } from "@langchain/ollama";
import * as fs from 'fs';
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { loadSummarizationChain } from "langchain/chains";
import { BaseLanguageModelInterface, BaseLanguageModelCallOptions } from "@langchain/core/language_models/base";
import { PromptTemplate } from "@langchain/core/prompts";
import * as crypto from 'crypto';
import * as defaults from './config'
import { TextLoader } from "langchain/document_loaders/fs/text";
import { ConfluencePagesLoader } from '@langchain/community/document_loaders/web/confluence'
import readline from 'readline'

const argv: minimist.ParsedArgs = minimist(process.argv.slice(2),{boolean: "overwrite"});

const databaseDir = argv["dbpath"];
const filesDir = argv["filesdir"];
const overwrite = argv["overwrite"];
const confluenceBaseUrl = "https://gs24.atlassian.net/wiki";


function validateArgs() {
    if (!databaseDir || !filesDir) {
        console.error("Please provide a database path (--dbpath) and a directory with files (--filesdir) to process");
        process.exit(1);
    }
    
    console.log("DATABASE PATH: ", databaseDir);
    console.log("FILES DIRECTORY: ", filesDir);
    console.log("OVERWRITE FLAG: ", overwrite);
}


const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});



const contentOverviewPromptTemplate = `Write a high-level one sentence content overview based on the text below:


"{text}"


WRITE THE CONTENT OVERVIEW ONLY, DO NOT WRITE ANYTHING ELSE:`;


const contentOverviewPrompt = new PromptTemplate({
  template: contentOverviewPromptTemplate,
  inputVariables: ["text"],
});

async function generateContentOverview(rawDocs: any, model: BaseLanguageModelInterface<any, BaseLanguageModelCallOptions>) {
  // This convenience function creates a document chain prompted to summarize a set of documents.
  const chain = loadSummarizationChain(model, { type: "map_reduce", combinePrompt: contentOverviewPrompt});
  const res = await chain.invoke({
    input_documents: rawDocs,
  });

  return res;
}

async function catalogRecordExists(catalogTable: lancedb.Table, hash: string): Promise<boolean> {
  const query = catalogTable.query().where(`hash="${hash}"`).limit(1);
  const results = await query.toArray();
  return results.length > 0;
}

const directoryLoader = new DirectoryLoader(
  filesDir,
  {
   ".pdf": (path: string) => new PDFLoader(path),
   ".md": (path: string) => new TextLoader(path),
  },
);

rl.question('Please enter your Confluence API token: ', (confluenceApiToken) => {
    rl.close();


    const confluencePagesLoader = new ConfluencePagesLoader(
        {
            baseUrl: confluenceBaseUrl,
            spaceKey: "DOCI",
            username: "oliver.schmitz@scout24.com",
            accessToken: confluenceApiToken,
        },
    );


    const model = new Ollama({model: defaults.SUMMARIZATION_MODEL});

    // prepares documents for summarization
    // returns already existing sources and new catalog records
    async function processDocuments(rawDocs: Document[], catalogTable: lancedb.Table, skipExistsCheck: boolean) {
        // group rawDocs by source for further processing
        const docsBySource = rawDocs.reduce((acc: Record<string, Document[]>, doc: Document) => {
            const source = doc.metadata.source;
            if (!acc[source]) {
                acc[source] = [];
            }
            acc[source].push(doc);
            return acc;
        }, {});

        let skipSources = [];
        let catalogRecords = [];

        // iterate over individual sources and get their summaries
        for (const [source, docs] of Object.entries(docsBySource)) {
            console.log(source)
            console.log(docs.length)

            var hash:string
            if ( source.startsWith( confluenceBaseUrl )) {
                if (docs[0].metadata.version !== null && docs[0].metadata.version !== undefined) {
                    hash = crypto.createHash('sha256').update(`${source}-${docs[0].metadata.version}`).digest('hex');
                }else{
                    throw new Error("Version is required for confluence pages")
                }
            } else {
                // Calculate hash of the source document
                const fileContent = await fs.promises.readFile(source);
                hash = crypto.createHash('sha256').update(fileContent).digest('hex');
            }
            // Check if a source document with the same hash already exists in the catalog
            const exists = skipExistsCheck ? false : await catalogRecordExists(catalogTable, hash);
            if (exists) {
                console.log(`Document with hash ${hash} already exists in the catalog. Skipping...`);
                skipSources.push(source);
            } else {
                const contentOverview = await generateContentOverview(docs, model);
                console.log(`Content overview for source ${source}:`, contentOverview);
                catalogRecords.push(new Document({pageContent: contentOverview["text"], metadata: {source, hash}}));
            }
        }

        return {skipSources, catalogRecords};
    }

    async function seed() {
        validateArgs();

        const db = await lancedb.connect(databaseDir);

        let catalogTable: lancedb.Table;
        let catalogTableExists = true;
        let chunksTable: lancedb.Table;

        try {
            catalogTable = await db.openTable(defaults.CATALOG_TABLE_NAME);
        } catch (e) {
            console.error(`Looks like the catalog table "${defaults.CATALOG_TABLE_NAME}" doesn't exist. We'll create it later.`);
            catalogTableExists = false;
        }

        try {
            chunksTable = await db.openTable(defaults.CHUNKS_TABLE_NAME);
        } catch (e) {
            console.error(`Looks like the chunks table "${defaults.CHUNKS_TABLE_NAME}" doesn't exist. We'll create it later.`);
        }

        // try dropping the tables if we need to overwrite
        if (overwrite) {
            try {
                await db.dropTable(defaults.CATALOG_TABLE_NAME);
            } catch (e) {
                console.log("Error dropping catalog table. Maybe they don't exist!");
            }
        }
        if (overwrite) {
            try {
                await db.dropTable(defaults.CHUNKS_TABLE_NAME);
            } catch (e) {
                console.log("Error dropping chunks table. Maybe they don't exist!");
            }
        }

        // load files from the files path
        console.log("Loading files...")
        const fileDocs = await directoryLoader.load();
        //const fileDocs = []
        console.log(`found ${fileDocs.length} files`);
        const confluenceDocs = await confluencePagesLoader.load()
        //const confluenceDocs = []
        console.log(`found ${confluenceDocs.length} confluence pages`);

        const rawDocs : Document[] = [...fileDocs, ...confluenceDocs];
        // overwrite the metadata as large metadata can give lancedb problems
        for (const doc of rawDocs) {
            doc.metadata = {
                loc: doc.metadata.loc,
                source: doc.metadata.source ??= doc.metadata.url ,
                ... doc.metadata.version? {version: doc.metadata.version}:{}};
        }

        console.log("Loading LanceDB catalog store...")

        const {
            skipSources,
            catalogRecords
        } = await processDocuments(rawDocs, catalogTable, overwrite || !catalogTableExists);
        const catalogStore = catalogRecords.length > 0 ?
            await LanceDB.fromDocuments(catalogRecords,
                new OllamaEmbeddings({model: defaults.EMBEDDING_MODEL}),
                {
                    mode: overwrite ? "overwrite" : undefined,
                    uri: databaseDir,
                    tableName: defaults.CATALOG_TABLE_NAME
                } as LanceDBArgs) :
            new LanceDB(new OllamaEmbeddings({model: defaults.EMBEDDING_MODEL}), {
                uri: databaseDir,
                table: catalogTable
            });
        console.log(catalogStore);

        console.log("Number of new catalog records: ", catalogRecords.length);
        console.log("Number of skipped sources: ", skipSources.length);
        //remove skipped sources from rawDocs
        const filteredRawDocs = rawDocs.filter((doc: any) => !skipSources.includes(doc.metadata.source));

        console.log("splitting documents...")
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: 500,
            chunkOverlap: 10,
        });
        const docs = await splitter.splitDocuments(filteredRawDocs);

        console.log("updating / creating LanceDB vector store...")

        var vectorStore : LanceDB;
        if ( docs.length > 0 ) {
            const chunkSize = 500;
            const chunk = docs.slice(0, chunkSize);
            vectorStore = await LanceDB.fromDocuments(
                chunk,
                new OllamaEmbeddings({ model: defaults.EMBEDDING_MODEL }),
                {
                    mode: "create",
                    uri: databaseDir,
                    tableName: defaults.CHUNKS_TABLE_NAME
                } as LanceDBArgs
            );
            console.log(`Processed chunk ${1} of ${Math.ceil(docs.length / chunkSize)}`);

            for (let i = chunkSize; i < docs.length; i += chunkSize) {
                const chunk = docs.slice(i, i + chunkSize);
                await vectorStore.addDocuments(chunk);
                console.log(`Processed chunk ${i / chunkSize + 1} of ${Math.ceil(docs.length / chunkSize)}`);
            }

        } else {
            new LanceDB(new OllamaEmbeddings({model: defaults.EMBEDDING_MODEL}), {
                uri: databaseDir,
                table: chunksTable
            });
        }

        console.log("Number of new chunks: ", docs.length);
        console.log(vectorStore);
    }

    seed();
});