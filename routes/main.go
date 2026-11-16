package main

import (
	"container/heap"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
)

type Request struct {
	AccidentLocation string                        `json:"accidentLocation"`
	Depots           []string                      `json:"depots"`
	Graph            map[string]map[string]float64 `json:"graph"`
}
type Result struct {
	FromDepot string   `json:"fromDepot"`
	To        string   `json:"to"`
	Path      []string `json:"path"`
	Distance  float64  `json:"distance"`
}
type item struct {
	node, origin string
	distance     float64
}
type priorityQueue []item

func (p priorityQueue) Len() int { return len(p) }
func (p priorityQueue) Less(i, j int) bool {
	if p[i].distance != p[j].distance {
		return p[i].distance < p[j].distance
	}
	if p[i].origin != p[j].origin {
		return p[i].origin < p[j].origin
	}
	return p[i].node < p[j].node
}
func (p priorityQueue) Swap(i, j int) { p[i], p[j] = p[j], p[i] }
func (p *priorityQueue) Push(x any)   { *p = append(*p, x.(item)) }
func (p *priorityQueue) Pop() any     { old := *p; n := len(old); x := old[n-1]; *p = old[:n-1]; return x }

var ErrUnreachable = errors.New("ninguna base puede llegar al accidente")

func shortestPath(r Request) (Result, error) {
	if len(r.Graph) == 0 || len(r.Graph) > 2000 || len(r.Depots) == 0 || len(r.Depots) > 2000 {
		return Result{}, errors.New("grafo o bases vacíos, o tamaño excedido")
	}
	if _, ok := r.Graph[r.AccidentLocation]; !ok {
		return Result{}, errors.New("el distrito del accidente no existe")
	}
	edges := 0
	for node, adj := range r.Graph {
		if strings.TrimSpace(node) == "" {
			return Result{}, errors.New("distrito vacío")
		}
		for neighbor, weight := range adj {
			edges++
			if _, ok := r.Graph[neighbor]; !ok {
				return Result{}, fmt.Errorf("distrito referenciado inexistente: %s", neighbor)
			}
			if weight < 0 || math.IsNaN(weight) || math.IsInf(weight, 0) {
				return Result{}, errors.New("las distancias deben ser números finitos no negativos")
			}
		}
	}
	if edges > 20000 {
		return Result{}, errors.New("demasiadas conexiones")
	}
	distances := map[string]float64{}
	origins := map[string]string{}
	previous := map[string]string{}
	for node := range r.Graph {
		distances[node] = math.Inf(1)
	}
	queue := &priorityQueue{}
	heap.Init(queue)
	for _, base := range r.Depots {
		if _, ok := r.Graph[base]; !ok {
			return Result{}, fmt.Errorf("base inexistente: %s", base)
		}
		if distances[base] == 0 {
			continue
		}
		distances[base] = 0
		origins[base] = base
		heap.Push(queue, item{base, base, 0})
	}
	for queue.Len() > 0 {
		current := heap.Pop(queue).(item)
		if current.distance != distances[current.node] || current.origin != origins[current.node] {
			continue
		}
		if current.node == r.AccidentLocation {
			path := []string{current.node}
			for node := current.node; node != current.origin; {
				parent, ok := previous[node]
				if !ok || len(path) > len(r.Graph) {
					return Result{}, errors.New("no se pudo reconstruir la ruta")
				}
				path = append(path, parent)
				node = parent
			}
			for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
				path[i], path[j] = path[j], path[i]
			}
			return Result{current.origin, r.AccidentLocation, path, current.distance}, nil
		}
		neighbors := make([]string, 0, len(r.Graph[current.node]))
		for neighbor := range r.Graph[current.node] {
			neighbors = append(neighbors, neighbor)
		}
		sort.Strings(neighbors)
		for _, neighbor := range neighbors {
			candidate := current.distance + r.Graph[current.node][neighbor]
			if math.IsInf(candidate, 0) {
				return Result{}, errors.New("distancia fuera de rango")
			}
			if candidate < distances[neighbor] || (candidate == distances[neighbor] && current.origin < origins[neighbor]) {
				distances[neighbor] = candidate
				origins[neighbor] = current.origin
				previous[neighbor] = current.node
				heap.Push(queue, item{neighbor, current.origin, candidate})
			}
		}
	}
	return Result{}, ErrUnreachable
}

func validToken(token, secret string) bool {
	if len(secret) < 32 {
		return false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return false
	}
	var header struct {
		Alg string `json:"alg"`
		Typ string `json:"typ"`
	}
	if json.Unmarshal(headerBytes, &header) != nil || header.Alg != "HS256" || header.Typ != "JWT" {
		return false
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var claims struct {
		Issuer    string `json:"iss"`
		Audience  string `json:"aud"`
		Subject   string `json:"sub"`
		Scope     string `json:"scope"`
		Expires   int64  `json:"exp"`
		NotBefore int64  `json:"nbf"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return false
	}
	now := time.Now().Unix()
	return claims.Issuer == "talsory-demo" && claims.Audience == "talsory-demo" && claims.Subject != "" && claims.Scope == "demo:review" && claims.Expires > now && claims.NotBefore <= now
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}
func handler(secret string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"status": "ok", "service": "routes-go", "version": "1.0.0"})
	})
	calculate := func(w http.ResponseWriter, r *http.Request) {
		if !validToken(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), secret) {
			writeJSON(w, 401, map[string]string{"code": "UNAUTHORIZED", "message": "JWT requerido o inválido"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 262144)
		decoder := json.NewDecoder(r.Body)
		decoder.DisallowUnknownFields()
		var input Request
		if err := decoder.Decode(&input); err != nil {
			writeJSON(w, 400, map[string]string{"code": "INVALID_INPUT", "message": "JSON inválido o demasiado grande"})
			return
		}
		if err := decoder.Decode(&struct{}{}); err != io.EOF {
			writeJSON(w, 400, map[string]string{"code": "INVALID_INPUT", "message": "Se espera un único objeto JSON"})
			return
		}
		result, err := shortestPath(input)
		if err != nil {
			status := 400
			code := "INVALID_GRAPH"
			if errors.Is(err, ErrUnreachable) {
				status = 422
				code = "UNREACHABLE"
			}
			writeJSON(w, status, map[string]string{"code": code, "message": err.Error()})
			return
		}
		writeJSON(w, 200, result)
	}
	mux.HandleFunc("POST /api/v1/routes/optimal", calculate)
	return mux
}
func main() {
	secret := os.Getenv("JWT_SECRET")
	if len(secret) < 32 {
		log.Fatal("JWT_SECRET debe tener al menos 32 caracteres")
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	server := &http.Server{Addr: ":" + port, Handler: handler(secret), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	log.Printf("routes-go escuchando en %s", port)
	log.Fatal(server.ListenAndServe())
}
