/*
 * fis
 * http://fis.baidu.com/
 */

'use strict';

var CACHE_DIR;


var exports = module.exports = function(file){
    if(!CACHE_DIR){
        fis.log.error('uninitialized compile cache directory.');
    }
    file = fis.file.wrap(file);
    if(!file.realpath){
        error('unable to compile [' + file.subpath + ']: Invalid file realpath.');
    }
    fis.log.debug('compile [' + file.realpath + '] start');
    fis.emitter.emit('compile:start', file);
    if(file.isFile()){
        if(file.useCompile && file.ext && file.ext !== '.'){
            var cache = file.cache = fis.cache(file.realpath, CACHE_DIR),
                revertObj = {};
            if(file.useCache && cache.revert(revertObj)){
                exports.settings.beforeCacheRevert(file);

                file.requires = revertObj.info.requires;
                file.extras = revertObj.info.extras;
                file.ast = revertObj.info.ast;

                if(file.isText()){
                    revertObj.content = revertObj.content.toString('utf8');
                }
                file.setContent(revertObj.content);
                exports.settings.afterCacheRevert(file);
            } else {
                exports.settings.beforeCompile(file);
                file.setContent(fis.util.read(file.realpath));
                process(file);
                exports.settings.afterCompile(file);
                revertObj = {
                    requires : file.requires,
                    extras : file.extras,
                    ast : file.ast
                };
                cache.save(file.getContent(), revertObj);
            }
        } else {
            file.setContent(file.isText() ? fis.util.read(file.realpath) : fis.util.fs.readFileSync(file.realpath));
        }
    } else if(file.useCompile && file.ext && file.ext !== '.'){
        process(file);
    }
    if(exports.settings.hash && file.useHash){
        file.getHash();
    }
    file.compiled = true;
    fis.log.debug('compile [' + file.realpath + '] end');
    fis.emitter.emit('compile:end', file);
    embeddedUnlock(file);
    return file;
};

exports.settings = {
    unique   : false,
    debug    : false,
    optimize : false,
    lint     : false,
    test     : false,
    hash     : false,
    domain   : false,
    beforeCacheRevert : function(){},
    afterCacheRevert : function(){},
    beforeCompile : function(){},
    afterCompile : function(){}
};

exports.setup = function(opt){
    var settings = exports.settings;
    if(opt){
        fis.util.map(settings, function(key){
            if(typeof opt[key] !== 'undefined'){
                settings[key] = opt[key];
            }
        });
    }
    CACHE_DIR = 'compile/';
    if(settings.unique){
        CACHE_DIR += Date.now() + '-' + Math.random();
    } else {
        CACHE_DIR += ''
            + (settings.debug    ? 'debug'     : 'release')
            + (settings.optimize ? '-optimize' : '')
            + (settings.hash     ? '-hash'     : '')
            + (settings.domain   ? '-domain'   : '');
    }
    return CACHE_DIR;
};

exports.clean = function(name){
    if(name){
        fis.cache.clean('compile/' + name);
    } else if(CACHE_DIR) {
        fis.cache.clean(CACHE_DIR);
    } else {
        fis.cache.clean('compile');
    }
};

var tokens = {};
['require', 'embed', 'uri', 'dep', 'jsEmbed'].forEach(function( k ) {
    tokens[k] = function( content ) {
      return {
        type : k,
        content : content
      };
    };
});

tokens.text = function(content){
  return {
    type : 'plain_text',
    content : content
  }
};

function flatten( arr ){
  return Array.prototype.concat.apply([], arr);
}

function tokenizer(reg, string, visitor){
  var token;
  var _tokens = [];

  var push = function ( node ){
    if( typeof node == 'string' ){
      console.log( node );
      throw new Error('illegal string token ' + node);
    }
    _tokens.push(node);
  }

  var start = 0;
  while( token = reg.exec(string) ){

    if(token.index != start){
      push( tokens.text( string.slice(start, token.index)) );
    }

    var ret = visitor.apply(null, token);

    if( !Array.isArray(ret) ){
      throw new Error('visitor must return an Array, but it return :' + JSON.stringify(ret)  + '\n'
                        +'with token ' + JSON.stringify(token) + '\n' 
                        +'and reg ' + reg + '\n' );
    }

    ret.forEach(function( token) {
      push(token);
    });

    start = token.index + token[0].length;
  }

  if( _tokens.length == 0 ){

    // no token found
    push(tokens.text(string));

  } else if( start != string.length ){

    // tails
    push(tokens.text(string.slice(start)));

  }

  return _tokens;
}

//"abc?__inline" return true
//"abc?__inlinee" return false
//"abc?a=1&__inline"" return true
function isInline(info){
    return /[?&]__inline(?:[=&'"]|$)/.test(info.query);
}

//analyse [@require id] syntax in comment
function analyseComment(comment){
  var reg = /(@require\s+)('[^']+'|"[^"]+"|[^\s;!@#%^&*()]+)/g;
  return tokenizer(reg, comment, function(m, prefix, value){
    return [tokens.text(prefix), tokens.require( value )];
  });
}

//expand javascript
//[@require id] in comment to require resource
//__inline(path) to embedd resource content or base64 encodings
//__uri(path) to locate resource
//require(path) to require resource
function extJs(content){
  var reg = /"(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*'|(\/\/[^\r\n\f]+|\/\*[\s\S]*?(?:\*\/|$))|\b(__inline|__uri|require)\s*\(\s*("(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*')\s*\)/g;
  return tokenizer(reg,content,function(m, comment, type, value){
    if(type){
      switch (type){
        case '__inline':
          return [tokens.jsEmbed(value)];
        case '__uri':
          return [tokens.uri(value)];
        case 'require':
          return [tokens.text('require('),tokens.require(value),tokens.text(')')];
      }
    } else if(comment){
      return analyseComment(comment);
    }
    return [tokens.text(m)];
  });
}


//expand css
//[@require id] in comment to require resource
//[@import url(path?__inline)] to embed resource content
//url(path) to locate resource
//url(path?__inline) to embed resource content or base64 encodings
//src=path to locate resource
function extCss(content){
  var reg = /(\/\*[\s\S]*?(?:\*\/|$))|(?:@import\s+)?\burl\s*\(\s*("(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*'|[^)}\s]+)\s*\)(\s*;?)|\bsrc\s*=\s*("(?:[^\\"\r\n\f]|\\[\s\S])*"|'(?:[^\\'\n\r\f]|\\[\s\S])*'|[^\s}]+)/g;
  return tokenizer(reg, content, function(m, comment, url, last, filter){
    if(url){
        var key = isInline(fis.util.query(url)) ? 'embed' : 'uri';
        if(m.indexOf('@') === 0){
          if(key === 'embed'){
            return [ tokens.embed( url ), tokens.text( last.replace(/;$/, '')) ];
          } else {
            return [ tokens.text( '@import url(' ), tokens.uri(url), tokens.text( ')' + last) ];
          }
        } else {
          return [ tokens.text( 'url(' ), tokens[key](url), tokens.text( ')' + last) ];
        }
    } else if(filter) {
      return [ tokens.text( 'src=' ), tokens.uri(filter)];
    } else if(comment) {
      return analyseComment(comment);
    }
  });
}


//expand html
//[@require id] in comment to require resource
//<!--inline[path]--> to embed resource content
//<img|embed|audio|video|link|object ... (data-)?src="path"/> to locate resource
//<img|embed|audio|video|link|object ... (data-)?src="path?__inline"/> to embed resource content
//<script|style ... src="path"></script|style> to locate js|css resource
//<script|style ... src="path?__inline"></script|style> to embed js|css resource
//<script|style ...>...</script|style> to analyse as js|css
function extHtml(content, callback){
  var reg = /(<script(?:(?=\s)[\s\S]*?["'\s\w\/\-]>|>))([\s\S]*?)(?=<\/script\s*>|$)|(<style(?:(?=\s)[\s\S]*?["'\s\w\/\-]>|>))([\s\S]*?)(?=<\/style\s*>|$)|<(img|embed|audio|video|link|object|source)\s+[\s\S]*?["'\s\w\/\-](?:>|$)|<!--inline\[([^\]]+)\]-->|<!--(?!\[)([\s\S]*?)(-->|$)/ig;
  return tokenizer(reg,content, function(m, $1, $2, $3, $4, $5, $6, $7, $8){
      if($1){//<script>
          var embed;
          $1 = tokenizer(/(\s(?:data-)?src\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig,$1, function(m, prefix, value){
              if(isInline(fis.util.query(value))){
                embed = tokens.embed(value);
                return [];
              } else {
                return [tokens.text(prefix), tokens.uri(value)];
              }
          });
          if(embed){
              //embed file
              m = flatten([$1, embed]);
          } else if(!/\s+type\s*=/i.test($1) || /\s+type\s*=\s*(['"]?)text\/javascript\1/i.test($1)) {
              //without attrubite [type] or must be [text/javascript]
              m = flatten([$1, extJs($2)]);
          } else {
              //other type as html
              m = flatten([$1, extHtml($2)]);
          }
      } else if($3){//<style>
          m = flatten([tokens.text($3), extCss($4)]);
      } else if($5){//<img|embed|audio|video|link|object|source>
          var tag = $5.toLowerCase();
          if(tag === 'link'){
              var inline = [];
              var isCssLink = false;
              var isImportLink = false;
              var result = m.match(/\srel\s*=\s*('[^']+'|"[^"]+"|[^\s\/>]+)/i);
              if(result && result[1]){
                  var rel = result[1].replace(/^['"]|['"]$/g, '').toLowerCase();
                  isCssLink = rel === 'stylesheet';
                  isImportLink = rel === 'import';
              }
              m = tokenizer(/(\s(?:data-)?href\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, m, function(_, prefix, value){
                  if((isCssLink || isImportLink) && isInline(fis.util.query(value))){
                    if(isCssLink) {
                        inline.push( 
                          tokens.text( '<style' + m.substring(5).replace(/\/(?=>$)/, '').replace(/\s+(?:charset|href|data-href|hreflang|rel|rev|sizes|target)\s*=\s*(?:'[^']+'|"[^"]+"|[^\s\/>]+)/ig, ''))
                        );
                    }
                    inline.push(tokens.embed(value));
                    if(isCssLink) {
                      inline.push(tokens.text('</style>'));
                    }
                    return [];
                  } else {
                    return [tokens.text(prefix), tokens.uri(value)];
                  }
              });
              m = inline || m;
          } else if(tag === 'object'){
              m = tokenizer(/(\sdata\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, m, function(m, prefix, value){
                  return [tokens.text(prefix), tokens.uri(value)];
              });
          } else {
              m = tokenizer(/(\s(?:data-)?src\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, m, function(m, prefix, value){
                  var key = isInline(fis.util.query(value)) ? 'embed' : 'uri';
                  return [tokens.text(prefix), tokens[key](value)];
              });
              if (tag == 'img') {
                  //<img src="image-src.png" srcset="image-1x.png 1x, image-2x.png 2x, image-3x.png 3x, image-4x.png 4x">
                  //http://www.webkit.org/demos/srcset/
                  var srcset = function( token ) {
                    return tokenizer(/(\ssrcset\s*=\s*)('[^']+'|"[^"]+"|[^\s\/>]+)/ig, token.content, function(m, prefix, value){
                        var info = fis.util.stringQuote(value);
                        var set = info.rest.split(',');
                        var imgset = [];

                        imgset.push( tokens.text(prefix + info.quote));

                        set.forEach(function (item) {
                            item = item.trim();
                            var p = item.indexOf(' ');
                            if (p == -1) {
                                imgset.push( tokens.text(item));
                                return;
                            }
                            imgset.push( tokens.uri(item.substr(0, p)) );
                            imgset.push( tokens.text(item.substr(p)) );
                            imgset.push( tokens.text(', ') );
                        });
                        imgset.pop();
                        imgset.push( tokens.text(info.quote));
                        return imgset;
                    });
                  }
                  
                  m = flatten(m.map(function( node ){
                    if(node.type == 'plain_text'){
                      return srcset(node);
                    } else {
                      return node;
                    }
                  }));
              }
          }
      } else if($6){
          m = [tokens.embed($6)];
      } else if($7){
          m = flatten([ tokens.text('<!--'), analyseComment($7), tokens.text($8)]);
      }

      return m;
  });
}


function process(file){
    if(file.useParser !== false){
        pipe(file, 'parser', file.ext);
    }
    if(file.rExt){
        if(file.usePreprocessor !== false){
            pipe(file, 'preprocessor', file.rExt);
        }
        if(file.useStandard !== false){
            standard(file);
        }
        if(file.usePostprocessor !== false){
            pipe(file, 'postprocessor', file.rExt);
        }
        if(exports.settings.lint && file.useLint !== false){
            pipe(file, 'lint', file.rExt, true);
        }
        if(exports.settings.test && file.useTest !== false){
            pipe(file, 'test', file.rExt, true);
        }
        if(exports.settings.optimize && file.useOptimizer !== false){
            pipe(file, 'optimizer', file.rExt);
        }
    }
}

function pipe(file, type, ext, keep){
    var key = type + ext;
    fis.util.pipe(key, function(processor, settings, key){
        settings.filename = file.realpath;
        var content = file.getContent();
        try {
            fis.log.debug('pipe [' + key + '] start');
            var result = processor(content, file, settings);
            fis.log.debug('pipe [' + key + '] end');
            if(keep){
                file.setContent(content);
            } else if(typeof result === 'undefined'){
                fis.log.warning('invalid content return of pipe [' + key + ']');
            } else {
                file.setContent(result);
            }
        } catch(e) {
            //log error
            fis.log.debug('pipe [' + key + '] fail');
            var msg = key + ': ' + String(e.message || e.msg || e).trim() + ' [' + (e.filename || file.realpath);
            if(e.hasOwnProperty('line')){
                msg += ':' + e.line;
                if(e.hasOwnProperty('col')){
                    msg += ':' + e.col;
                } else if(e.hasOwnProperty('column')) {
                    msg += ':' + e.column;
                }
            }
            msg += ']';
            e.message = msg;
            error(e);
        }
    });
}

var embeddedMap = {};

function error(msg){
    //for watching, unable to exit
    embeddedMap = {};
    fis.log.error(msg);
}

function embeddedCheck(main, embedded){
    main = fis.file.wrap(main).realpath;
    embedded = fis.file.wrap(embedded).realpath;
    if(main === embedded){
        error('unable to embed file[' + main + '] into itself.');
    } else if(embeddedMap[embedded]) {
        var next = embeddedMap[embedded],
            msg = [embedded];
        while(next && next !== embedded){
            msg.push(next);
            next = embeddedMap[next];
        }
        msg.push(embedded);
        error('circular dependency on [' + msg.join('] -> [') + '].');
    }
    embeddedMap[embedded] = main;
    return true;
}

function embeddedUnlock(file){
    delete embeddedMap[file.realpath];
}

function addDeps(a, b){
    if(a && a.cache && b){
        if(b.cache){
            a.cache.mergeDeps(b.cache);
        }
        a.cache.addDeps(b.realpath || b);
    }
}
function standard(file){
  var path = file.realpath;
  var content = file.getContent();
  var ast;

  if(typeof content === 'string'){
    fis.log.debug('standard start');

    //extend language ability
    if(file.isHtmlLike){
      ast = extHtml(content);
    } else if(file.isJsLike){
      ast = extJs(content);
    } else if(file.isCssLike){
      ast = extCss(content);
    }

    fis.log.debug('ast tokens : ' + ast.length);

    ast.forEach(function( node ) {
      if( !('type' in node) || !('content' in node)){
        throw new Error('illegal token', token);
      }
      var ret = '', info;
      var value = node.content;
      try{
        switch(node.type){
          case 'plain_text':
              node.quote = '';
              break;
          case 'require':
              info = fis.uri.getId(value, file.dirname);
              file.addRequire(info.id);
              node.content = info.id;
              node.quote = info.quote;
              break;
          case 'uri':
              info = fis.uri(value, file.dirname);
              if(info.file && info.file.isFile()){
                if(embeddedCheck(file, info.file)){
                  exports(info.file);
                  addDeps(file, info.file);

                  node.content = info.file.realpath;
                  node.query = (info.file.query && info.query) ? '&' + info.query.substring(1) : info.query;
                  node.hash = info.hash || info.file.hash;
                  node.quote = info.quote;
                }
              } else {
                node.missing_file = true;
              }
              break;
          case 'dep':
              if(file.cache){
                  info = fis.uri(value, file.dirname);
                  addDeps(file, info.file);
              } else {
                  fis.log.warning('unable to add deps to file [' + path + ']');
              }
              break;
          case 'embed':
          case 'jsEmbed':
              info = fis.uri(value, file.dirname);
              node.quote = info.quote;
              var f;
              if(info.file){
                  f = info.file;
              } else if(fis.util.isAbsolute(info.rest)){
                  f = fis.file(info.rest);
              }
              if(f && f.isFile()){
                // 如果检查不过 这个函数会抛出一个错误，所以没有必要写else
                if(embeddedCheck(file, f)){
                  exports(f);
                  addDeps(file, f);

                  f.requires.forEach(function(id){
                    file.addRequire(id);
                  });

                  node.content = f.realpath;
                }
              } else {
                  fis.log.error('unable to embed non-existent file [' + value + ']');
              }
              break;
          default :
              fis.log.error('unsupported fis language tag [' + node.type + ']');
        }
      } catch (e) {
        embeddedMap = {};
        e.message = e.message + ' in [' + file.subpath + ']';
        throw  e;
      }
    });

    file.ast = ast;

    content = [];

    var liburl = require('url');
    var f_url = liburl.parse(file.url);

    var visit_ast =function ( ast ) {
      ast.forEach(function(node) {
        var value = node.content;
        switch(node.type){
          case 'plain_text' :
          case 'require' : 
            content.push(node.quote + value + node.quote);
            break;
          case 'uri' : 
            if( node.missing_file ){
              fis.log.warning('missing file! ' + node.content + ', ' + file.realpath);
              content.push(value);
            } else {
              var url = fis.file(node.content)
                            .getUrl(exports.settings.hash, exports.settings.domain);

              fis.log.debug( ' insertRelativeUrl ' + file.insertRelativeUrl );

              if( file.insertRelativeUrl ){
                fis.log.warning('experimental feature');
                var path = require('path');
                var o_url = liburl.parse(url);

                if( !o_url.host ){
                  url = path.relative(f_url.pathname, url).replace(/\\/g, '/');
                }
              }

              content.push(node.quote + url + node.query + node.hash + node.quote);
            }
            break;
          case 'dep' : 
            // do nothing
            break;

          case 'embed' :
          case 'jsEmbed' :
            // load cache here
            var cache = fis.cache(value, CACHE_DIR);
            var f = fis.file(value);
            f.setContent(cache.content);

            if(f.isText()){
              if(type === 'jsEmbed' && !f.isJsLike && !f.isJsonLike){
                content.push(JSON.stringify(cache.content));
              }else{
                //  对于inline的css / html，递归访问ast
                if( cache.ast.length ){
                  visit_ast(cache.ast);
                } else {
                  content.push(cache.content);
                }
              }
            } else {
                content.push(node.quote + f.getBase64() + node.quote);
            }
            break;
        }
      })
    }

    visit_ast(ast);

    file.setContent(content.join(''));
    fis.log.debug('standard end');
  }
}


exports.tokenizer = tokenizer;
exports.extJs = extJs;
exports.extCss = extCss;
exports.extHtml = extHtml;
exports.isInline = isInline;
exports.analyseComment = analyseComment;
