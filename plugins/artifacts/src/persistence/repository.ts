import type { OwnerRepository, RepositoryDeclaration, ReadSnapshot, SyncTransaction } from '@aork/sdk/server';
import { artifactSchema, artifactVersionSchema, type Artifact, type ArtifactVersion } from '@aork/contracts/artifact';
type Read=SyncTransaction|ReadSnapshot;
export const persistence:RepositoryDeclaration={namespace:'plugin_artifacts__',migrations:[{version:1,statements:[
 'CREATE TABLE plugin_artifacts__artifacts (id TEXT PRIMARY KEY, principal TEXT NOT NULL, project_id TEXT NOT NULL, record TEXT NOT NULL)',
 'CREATE TABLE plugin_artifacts__versions (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES plugin_artifacts__artifacts(id), ordinal INTEGER NOT NULL, content_id TEXT UNIQUE, record TEXT NOT NULL, UNIQUE(artifact_id,ordinal))',
 'CREATE INDEX plugin_artifacts__project ON plugin_artifacts__artifacts(principal,project_id,id)',
]}],statements:{
 artifact:{sql:'SELECT principal,record FROM plugin_artifacts__artifacts WHERE id=?',mode:'read'},
 version:{sql:'SELECT record FROM plugin_artifacts__versions WHERE id=?',mode:'read'},
 list:{sql:'SELECT record FROM plugin_artifacts__artifacts WHERE principal=? AND project_id=? AND id>? ORDER BY id LIMIT 26',mode:'read'},
 versions:{sql:'SELECT record FROM plugin_artifacts__versions WHERE artifact_id=? AND ordinal>? ORDER BY ordinal LIMIT 26',mode:'read'},
 latest:{sql:'SELECT record FROM plugin_artifacts__versions WHERE artifact_id=? ORDER BY ordinal DESC LIMIT 1',mode:'read'},
 inventory:{sql:'SELECT id,content_id,record FROM plugin_artifacts__versions WHERE content_id IS NOT NULL AND content_id>? ORDER BY content_id LIMIT 26',mode:'read'},
 insertArtifact:{sql:'INSERT INTO plugin_artifacts__artifacts(id,principal,project_id,record) VALUES (?,?,?,?)',mode:'write'},
 updateArtifact:{sql:'UPDATE plugin_artifacts__artifacts SET record=? WHERE id=?',mode:'write'},
 insertVersion:{sql:'INSERT INTO plugin_artifacts__versions(id,artifact_id,ordinal,content_id,record) VALUES (?,?,?,?,?)',mode:'write'},
}};
export function artifactRepository(binding:OwnerRepository){
 const version=(row:{record:string}|undefined)=>row?artifactVersionSchema.parse(JSON.parse(row.record)):undefined;
 return{
  artifact(id:string,tx?:Read){const row=binding.all<{principal:string;record:string}>('artifact',[id],tx)[0];return row?{principal:row.principal,artifact:artifactSchema.parse(JSON.parse(row.record))}:undefined;},
  version(id:string,tx?:Read){return version(binding.all<{record:string}>('version',[id],tx)[0]);},
  latest(id:string,tx?:Read){return version(binding.all<{record:string}>('latest',[id],tx)[0]);},
  list(principal:string,projectId:string,after:string,tx?:Read){return binding.all<{record:string}>('list',[principal,projectId,after],tx).map(row=>artifactSchema.parse(JSON.parse(row.record)));},
  versions(id:string,after:number,tx?:Read){return binding.all<{record:string}>('versions',[id,after],tx).map(row=>artifactVersionSchema.parse(JSON.parse(row.record)));},
  inventory(after:string,tx?:Read){return binding.all<{record:string}>('inventory',[after],tx).map(row=>artifactVersionSchema.parse(JSON.parse(row.record)));},
  insertArtifact(tx:SyncTransaction,principal:string,value:Artifact){binding.run(tx,'insertArtifact',[value.id,principal,value.projectId,JSON.stringify(value)]);},
  updateArtifact(tx:SyncTransaction,value:Artifact){binding.run(tx,'updateArtifact',[JSON.stringify(value),value.id]);},
  insertVersion(tx:SyncTransaction,value:ArtifactVersion){binding.run(tx,'insertVersion',[value.id,value.artifactId,value.ordinal,value.content.kind==='captured-file'?value.content.contentId:null,JSON.stringify(value)]);},
 };
}
