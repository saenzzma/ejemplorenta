package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNearestDepot(t *testing.T) {
	r := Request{"San Isidro", []string{"Ate", "Miraflores"}, map[string]map[string]float64{"Miraflores": {"San Isidro": 7, "Barranco": 3}, "San Isidro": {"Miraflores": 7, "Lince": 4}, "Barranco": {"Miraflores": 3, "Surco": 5}, "Lince": {"San Isidro": 4, "Surco": 6}, "Surco": {"Barranco": 5, "Lince": 6, "Ate": 10}, "Ate": {"Surco": 10}}}
	got, err := shortestPath(r)
	if err != nil || got.FromDepot != "Miraflores" || got.Distance != 7 {
		t.Fatalf("%+v %v", got, err)
	}
}
func TestIndirectDirectedRoute(t *testing.T) {
	got, err := shortestPath(Request{"C", []string{"A", "D"}, map[string]map[string]float64{"A": {"C": 20, "B": 2}, "B": {"C": 3}, "C": {}, "D": {"C": 9}}})
	if err != nil || got.Distance != 5 || strings.Join(got.Path, ",") != "A,B,C" {
		t.Fatalf("%+v %v", got, err)
	}
}
func TestUnreachable(t *testing.T) {
	_, err := shortestPath(Request{"B", []string{"A"}, map[string]map[string]float64{"A": {}, "B": {}}})
	if !errors.Is(err, ErrUnreachable) {
		t.Fatal(err)
	}
}
func TestRejectNegative(t *testing.T) {
	_, err := shortestPath(Request{"B", []string{"A"}, map[string]map[string]float64{"A": {"B": -1}, "B": {}}})
	if err == nil {
		t.Fatal("aceptó un peso negativo")
	}
}
func TestZeroAndSameDepot(t *testing.T) {
	got, err := shortestPath(Request{"A", []string{"A"}, map[string]map[string]float64{"A": {"B": 0}, "B": {"A": 0}}})
	if err != nil || got.Distance != 0 || len(got.Path) != 1 {
		t.Fatalf("%+v %v", got, err)
	}
}
func TestTieDeterministic(t *testing.T) {
	got, err := shortestPath(Request{"C", []string{"B", "A"}, map[string]map[string]float64{"A": {"C": 2}, "B": {"C": 2}, "C": {}}})
	if err != nil || got.FromDepot != "A" {
		t.Fatalf("%+v %v", got, err)
	}
}
func TestJWTAndHTTP(t *testing.T) {
	secret := strings.Repeat("x", 32)
	api := handler(secret)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/routes/optimal", strings.NewReader(`{"accidentLocation":"A","depots":["A"],"graph":{"A":{}}}`))
	w := httptest.NewRecorder()
	api.ServeHTTP(w, req)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
	encode := base64.RawURLEncoding.EncodeToString
	header := encode([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload := encode([]byte(fmt.Sprintf(`{"iss":"talsory-demo","aud":"talsory-demo","sub":"reviewer","scope":"demo:review","exp":%d}`, time.Now().Unix()+60)))
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(header + "." + payload))
	token := header + "." + payload + "." + encode(mac.Sum(nil))
	if !validToken(token, secret) {
		t.Fatal("rechazó JWT válido")
	}
	if validToken(token+"x", secret) {
		t.Fatal("aceptó JWT adulterado")
	}
	req = httptest.NewRequest(http.MethodPost, "/api/v1/routes/optimal", strings.NewReader(`{"accidentLocation":"A","depots":["A"],"graph":{"A":{}}}`))
	req.Header.Set("Authorization", "Bearer "+token)
	w = httptest.NewRecorder()
	api.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}
